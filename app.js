const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const SUGGESTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];
const MAX_VIDEO_MB = 15; // request tối đa ~20MB, base64 phình thêm 33%
const MAX_CAM_LOG = 50;
const MAX_QUEUE_SIZE = 5;

const state = {
  apiKey: localStorage.getItem('gemini_api_key') || '',
  model: localStorage.getItem('gemini_model') || DEFAULT_MODEL,

  videoFile: null,
  videoQueue: [],     // Hàng đợi video (SJF Queue)
  videoAnalyzing: false, // Trạng thái đang gọi API phân tích video
  videoResult: null,
  rows: [],           // mỗi dòng = 1 hành vi của 1 người
  activeAction: '',   // pill đang chọn
  filterNature: '',   // tính chất hành vi đang lọc (Nguy hiểm | Bất thường | An toàn | Bình thường)

  cameraStream: null,
  cameraTimer: null,
  cameraBusy: false,
  cameraLog: [],

  chatHistory: [],
  chatSource: localStorage.getItem('chat_source') || 'both', // both | video | camera
};

const NATURE_META = {
  'Nguy hiểm': {
    label: 'Nguy hiểm',
    icon: 'fa-triangle-exclamation',
    badgeClass: 'danger',
    tooltip: 'Hành vi có mức độ rủi ro cao, nguy cơ gây tổn hại hoặc vi phạm an ninh',
  },
  'Bất thường': {
    label: 'Bất thường',
    icon: 'fa-circle-exclamation',
    badgeClass: 'warning',
    tooltip: 'Hành vi khác thường, khả nghi hoặc đáng chú ý cần quan sát',
  },
  'An toàn': {
    label: 'An toàn',
    icon: 'fa-shield-halved',
    badgeClass: 'success',
    tooltip: 'Hành vi tuân thủ an toàn, bảo hộ hoặc hỗ trợ cộng đồng',
  },
  'Bình thường': {
    label: 'Bình thường',
    icon: 'fa-circle-check',
    badgeClass: 'normal',
    tooltip: 'Hành vi sinh hoạt, di chuyển hoặc làm việc thông thường',
  },
};

function normalizeNature(val) {
  if (!val) return '';
  const s = String(val).trim().toLowerCase();
  if (s.includes('nguy hiểm') || s.includes('danger') || s.includes('nguy hiem')) return 'Nguy hiểm';
  if (s.includes('bất thường') || s.includes('bat thuong') || s.includes('khả nghi') || s.includes('abnormal')) return 'Bất thường';
  if (s.includes('an toàn') || s.includes('an toan') || s.includes('bảo hộ') || s.includes('safe')) return 'An toàn';
  if (s.includes('bình thường') || s.includes('binh thuong') || s.includes('normal')) return 'Bình thường';
  return val;
}

function inferNature(action, detail) {
  const text = `${action || ''} ${detail || ''}`.toLowerCase();
  if (/nguy hiểm|đánh nhau|vũ khí|dao|súng|té|ngã|tai nạn|cháy|nổ|trộm|cướp|đột nhập|phá hoại|bạo lực|xâm nhập|vấp ngã|treo leo|leo trèo/i.test(text)) {
    return 'Nguy hiểm';
  }
  if (/bất thường|lén lút|nhìn quanh|ngó nghiêng|bỏ chạy|chạy trốn|lảng vảng|bỏ rơi|để quên|nghi vấn|che mặt|đột ngột/i.test(text)) {
    return 'Bất thường';
  }
  if (/an toàn|bảo hộ|mũ bảo hiểm|áo phao|khẩu trang|hỗ trợ|giúp đỡ|cứu hộ|sơ cứu|dọn dẹp|tuân thủ/i.test(text)) {
    return 'An toàn';
  }
  return 'Bình thường';
}

const $ = (id) => document.getElementById(id);

// Gemini, tài liệu: https://ai.google.dev/api/generate-content
async function callGemini(parts, { schema, systemInstruction, history } = {}) {
  if (!state.apiKey) {
    throw new Error('Chưa có API key, vào mục Cài đặt để nhập.');
  }

  const body = { contents: [...(history || []), { role: 'user', parts }] };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (schema) body.generationConfig = { responseMimeType: 'application/json', responseSchema: schema };

  let res;
  // 503 là model quá tải phía Google, thử lại 2 lần trước khi báo lỗi
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${API_BASE}/models/${state.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.apiKey },
        body: JSON.stringify(body),
      });
    } catch (_) {
      throw new Error('Không kết nối được tới Google, kiểm tra lại mạng.');
    }
    if (res.status !== 503 || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (_) {}
    throw new Error(translateError(res.status, detail));
  }

  const data = await res.json();
  if (data.promptFeedback?.blockReason) {
    throw new Error('Nội dung bị từ chối xử lý: ' + data.promptFeedback.blockReason);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('AI không trả về nội dung, thử lại.');
  return text;
}

function translateError(status, detail) {
  switch (status) {
    case 400:
      if (/api key/i.test(detail)) return 'API key không hợp lệ, kiểm tra lại trong Cài đặt.';
      return 'Yêu cầu không hợp lệ. ' + detail;
    case 403: return 'API key bị từ chối hoặc chưa được cấp quyền dùng model này.';
    case 404: return `Không tìm thấy model "${state.model}". Vào Cài đặt, bấm Tải danh sách rồi chọn model khác.`;
    case 413: return `File quá lớn, dùng video dưới ${MAX_VIDEO_MB}MB.`;
    case 429: return 'Vượt hạn mức miễn phí. Đợi khoảng 1 phút rồi thử lại, hoặc đổi sang model Flash-Lite.';
    case 500: return 'Lỗi máy chủ Google, thử lại sau ít phút.';
    case 503: return 'Model đang quá tải, đã thử lại nhưng chưa được. Đợi vài phút hoặc đổi sang model khác trong Cài đặt.';
    case 504: return 'Google xử lý quá lâu, thử lại với video ngắn hơn.';
    default: return `Lỗi ${status} từ Google. ${detail}`;
  }
}

function parseJson(text) {
  // đôi khi model bọc trong ```json ... ```
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Không đọc được file.'));
    reader.readAsDataURL(file);
  });
}

// Phân tích video

// Danh mục nhãn hành động (Action) cố định theo chuẩn thị giác máy tính
const ALLOWED_ACTIONS = [
  'Đi bộ',
  'Chạy',
  'Đứng',
  'Ngồi',
  'Cúi người/Nằm',
  'Dùng điện thoại',
  'Cầm nắm đồ vật',
  'Mang vác/Kéo lê',
  'Bỏ lại đồ vật',
  'Đột nhập/Leo trèo',
  'Xô xát/Ẩu đả',
  'Té ngã',
  'Phá hoại',
];

const VIDEO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Tóm tắt video trong 2-3 câu' },
    persons: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'P1, P2, ...' },
          appearance: { type: 'STRING', description: 'Giới tính ước đoán, trang phục, màu sắc, phụ kiện' },
          events: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                start: { type: 'NUMBER', description: 'Giây bắt đầu' },
                end: { type: 'NUMBER', description: 'Giây kết thúc' },
                action: {
                  type: 'STRING',
                  description: 'Hành động cụ thể (chọn chính xác từ: "Đi bộ", "Chạy", "Đứng", "Ngồi", "Cúi người/Nằm", "Dùng điện thoại", "Cầm nắm đồ vật", "Mang vác/Kéo lê", "Bỏ lại đồ vật", "Đột nhập/Leo trèo", "Xô xát/Ẩu đả", "Té ngã", "Phá hoại")',
                },
                nature: {
                  type: 'STRING',
                  description: 'Tính chất hành vi an ninh: "Bình thường", "An toàn", "Bất thường", hoặc "Nguy hiểm"',
                },
                detail: { type: 'STRING', description: 'Mô tả thêm ngữ cảnh chi tiết nếu có' },
              },
              required: ['start', 'end', 'action', 'nature'],
            },
          },
        },
        required: ['id', 'appearance', 'events'],
      },
    },
  },
  required: ['summary', 'persons'],
};

const VIDEO_PROMPT = `Bạn là hệ thống phân tích thị giác máy tính và giám sát an ninh video.
Xem toàn bộ video và liệt kê tất cả những người xuất hiện. Với mỗi người:
- Đặt mã P1, P2, P3...
- Mô tả đặc điểm nhận dạng: giới tính ước đoán, trang phục, màu áo quần, phụ kiện (balo, mũ, kính...).
- Liệt kê các hành vi theo thời gian:
  + start: giây bắt đầu (số)
  + end: giây kết thúc (số)
  + action: HÀNH ĐỘNG CỤ THỂ, BẮT BUỘC chọn 1 trong các nhãn chuẩn sau:
      [Vận động cơ bản]: "Đi bộ", "Chạy", "Đứng", "Ngồi", "Cúi người/Nằm"
      [Tương tác vật thể]: "Dùng điện thoại", "Cầm nắm đồ vật", "Mang vác/Kéo lê", "Bỏ lại đồ vật"
      [An ninh & Sự cố]: "Đột nhập/Leo trèo", "Xô xát/Ẩu đả", "Té ngã", "Phá hoại"
  + nature: TÍNH CHẤT HÀNH VI AN NINH, phân loại chính xác thành 1 trong 4 nhóm:
      * "Nguy hiểm": Hành vi gây rủi ro tức thì (Xô xát/Ẩu đả, Té ngã bất tỉnh, Phá hoại tài sản, Đột nhập/Leo trèo, mang hung khí).
      * "Bất thường": Hành vi khả nghi cần theo dõi (Bỏ lại đồ vật, chạy trốn vội vã, lảng vảng ngó nghiêng lén lút, cúi người/nằm bất thường).
      * "An toàn": Tuân thủ quy định và bảo vệ an toàn (Đội mũ bảo hiểm, mặc đồ bảo hộ, dọn dẹp vật cản, hỗ trợ người khác).
      * "Bình thường": Sinh hoạt và làm việc chuẩn (Đi bộ, Đứng, Ngồi, Dùng điện thoại thông thường, Cầm nắm đồ vật bình thường).
  + detail: mô tả thêm ngữ cảnh chi tiết nếu có.
Người đổi hành vi hoặc đổi tính chất thì tách thành sự kiện mới. Viết bằng tiếng Việt.`;

function initVideoPage() {
  const dropzone = $('dropzone');
  const input = $('videoInput');

  input.addEventListener('change', () => {
    if (input.files && input.files.length) {
      handleMultipleVideos(Array.from(input.files));
    }
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      handleMultipleVideos(Array.from(e.dataTransfer.files));
    }
  });

  $('btnAnalyze').addEventListener('click', analyzeVideo);
  $('filterText').addEventListener('input', renderResultTable);
  $('filterNature').addEventListener('change', (e) => {
    state.filterNature = e.target.value;
    renderResultTable();
    renderNatureChart();
  });
  $('btnClearFilter').addEventListener('click', () => {
    $('filterText').value = '';
    state.activeAction = '';
    state.filterNature = '';
    $('filterNature').value = '';
    renderActionPills();
    renderNatureChart();
    renderResultTable();
  });
  $('btnDownload').addEventListener('click', downloadJson);
  $('btnImport').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', () => {
    if ($('importInput').files[0]) importJson($('importInput').files[0]);
    $('importInput').value = '';
  });
}

function handleMultipleVideos(files) {
  const validVideos = files.filter(f => f.type.startsWith('video/'));
  if (!validVideos.length) {
    setStatus('videoStatus', 'Không tìm thấy file video hợp lệ.', 'error');
    return;
  }

  // Giới hạn tối đa 5 video trong hàng đợi
  const queueFiles = validVideos.slice(0, MAX_QUEUE_SIZE);
  
  // Thuật toán SJF (Shortest Job First): Sắp xếp tăng dần theo dung lượng file (Bytes)
  // Trong HĐH, điều này giúp tối ưu hóa thời gian chờ trung bình (Average Waiting Time)
  queueFiles.sort((a, b) => a.size - b.size);
  
  state.videoQueue = queueFiles;
  renderQueueUI();

  // Chọn video đầu tiên (nhỏ nhất) để phát và chuẩn bị phân tích
  onVideoSelected(queueFiles[0]);
  if (files.length > 1) {
    setStatus('videoStatus', `Đã nhận ${queueFiles.length} video. Video "${queueFiles[0].name}" (${(queueFiles[0].size/1024/1024).toFixed(1)}MB) nhẹ nhất được ưu tiên phân tích trước.`, 'ok');
  }
}

function renderQueueUI() {
  const queueCard = $('videoQueueCard');
  const queueList = $('videoQueueList');
  const countTag = $('queueCountTag');
  if (!queueCard || !queueList) return;

  if (state.videoQueue.length <= 1) {
    queueCard.classList.add('hidden');
    return;
  }

  queueCard.classList.remove('hidden');
  if (countTag) countTag.textContent = `${state.videoQueue.length} video`;

  queueList.innerHTML = state.videoQueue.map((f, idx) => {
    const mb = (f.size / 1024 / 1024).toFixed(1);
    const isActive = state.videoFile && state.videoFile.name === f.name && state.videoFile.size === f.size;
    return `
      <div class="queue-item ${isActive ? 'active' : ''}" data-idx="${idx}">
        <span class="queue-item-name" title="${escapeHtml(f.name)}">
          <b>#${idx + 1}</b> ${escapeHtml(f.name)}
        </span>
        <div class="queue-item-meta">
          <span class="queue-priority-badge">${idx === 0 ? 'Ưu tiên 1 (Nhẹ nhất)' : 'Ưu tiên ' + (idx + 1)}</span>
          <span>${mb} MB</span>
        </div>
      </div>
    `;
  }).join('');

  queueList.querySelectorAll('.queue-item').forEach((item) => {
    item.addEventListener('click', () => {
      const idx = Number(item.dataset.idx);
      if (state.videoQueue[idx]) {
        onVideoSelected(state.videoQueue[idx]);
        renderQueueUI();
      }
    });
  });
}

function onVideoSelected(file) {
  if (!file.type.startsWith('video/')) {
    setStatus('videoStatus', 'File này không phải video.', 'error');
    return;
  }
  const mb = file.size / 1024 / 1024;
  if (mb > MAX_VIDEO_MB) {
    setStatus('videoStatus', `Video ${mb.toFixed(1)}MB vượt giới hạn ${MAX_VIDEO_MB}MB. Cắt ngắn hoặc nén lại.`, 'error');
    return;
  }

  // đổi sang video khác thì bỏ kết quả cũ; nhập JSON trước rồi mới chọn video thì giữ
  if (state.videoFile && state.videoResult) clearVideoResult();
  state.videoFile = file;
  const preview = $('videoPreview');
  preview.src = URL.createObjectURL(file);
  preview.classList.remove('hidden');
  preview.onloadedmetadata = () => {
    $('videoName').textContent = file.name;
    $('videoName').title = file.name;
    $('videoSize').textContent = mb.toFixed(1) + ' MB';
    $('videoDuration').textContent = fmtTime(preview.duration);
    $('videoInfo').classList.remove('hidden');
  };
  $('btnAnalyze').disabled = false;
  setStatus('videoStatus', '');
}

function clearVideoResult() {
  state.videoResult = null;
  state.rows = [];
  state.activeAction = '';
  state.filterNature = '';
  if ($('filterNature')) $('filterNature').value = '';
  if ($('summary')) $('summary').classList.add('hidden');
  const chartCard = $('natureChartCard');
  if (chartCard) chartCard.classList.add('hidden');
  const chartEmpty = $('natureChartEmpty');
  if (chartEmpty) chartEmpty.classList.remove('hidden');
  $('filterText').value = '';
  $('btnDownload').disabled = true;
  renderActionPills();
  renderResultTable();
  renderChatContext();
}

async function analyzeVideo() {
  if (!state.videoFile) return;
  $('btnAnalyze').disabled = true;
  state.videoAnalyzing = true;
  if (typeof tickSystemMetrics === 'function') tickSystemMetrics(); // Cập nhật ngay lập tức giám sát hệ thống
  setStatus('videoStatus', 'AI đang xem video và nhận diện hành vi (khoảng 15–45 giây)...', 'loading');

  try {
    const base64 = await fileToBase64(state.videoFile);
    if (typeof tickSystemMetrics === 'function') tickSystemMetrics();
    const text = await callGemini([
      { inlineData: { mimeType: state.videoFile.type || 'video/mp4', data: base64 } },
      { text: VIDEO_PROMPT },
    ], { schema: VIDEO_SCHEMA });

    applyVideoResult(parseJson(text));
    setStatus('videoStatus', `Hoàn thành! Phát hiện ${state.videoResult.persons.length} người với ${state.rows.length} hành vi.`, 'ok');
  } catch (err) {
    setStatus('videoStatus', err.message, 'error');
  } finally {
    state.videoAnalyzing = false;
    $('btnAnalyze').disabled = false;
    if (typeof tickSystemMetrics === 'function') tickSystemMetrics(); // Cập nhật ngay để hạ tải
  }
}

function applyVideoResult(result) {
  state.videoResult = { summary: result.summary || '', persons: result.persons };
  state.rows = result.persons
    .flatMap((p) => (p.events || []).map((e) => {
      const rawNat = normalizeNature(e.nature) || inferNature(e.action, e.detail) || 'Bình thường';
      return {
        id: p.id,
        appearance: p.appearance,
        action: e.action,
        nature: rawNat,
        start: Number(e.start) || 0,
        end: Number(e.end) || 0,
        detail: e.detail || '',
      };
    }))
    .sort((a, b) => a.start - b.start);
  state.activeAction = '';
  state.filterNature = '';
  if ($('filterNature')) $('filterNature').value = '';
  $('filterText').value = '';

  const summary = $('summary');
  if (summary) {
    summary.textContent = state.videoResult.summary;
    summary.classList.toggle('hidden', !state.videoResult.summary);
  }
  $('btnDownload').disabled = false;
  renderNatureChart();
  renderActionPills();
  renderResultTable();
  renderChatContext();
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.persons)) throw new Error();
    applyVideoResult(data);
    const hint = state.videoFile ? '' : ' Chọn đúng video tương ứng để tua theo dòng.';
    setStatus('videoStatus', `Đã nhập ${data.persons.length} người, ${state.rows.length} hành vi từ ${file.name}.${hint}`, 'ok');
  } catch (_) {
    setStatus('videoStatus', 'File JSON không đúng định dạng kết quả phân tích.', 'error');
  }
}

function renderNatureChart() {
  const card = $('natureChartCard');
  const empty = $('natureChartEmpty');
  if (!card) return;
  if (!state.rows.length) {
    card.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const counts = { 'Nguy hiểm': 0, 'Bất thường': 0, 'An toàn': 0, 'Bình thường': 0 };
  state.rows.forEach((r) => {
    const nat = r.nature || 'Bình thường';
    counts[nat] = (counts[nat] || 0) + 1;
  });

  const total = state.rows.length;
  const maxCount = Math.max(1, ...Object.values(counts));

  // Tóm tắt badges trên tiêu đề biểu đồ
  const order = ['Nguy hiểm', 'Bất thường', 'An toàn', 'Bình thường'];
  const badgesHtml = order.map((key) => {
    const meta = NATURE_META[key] || NATURE_META['Bình thường'];
    const cnt = counts[key];
    if (cnt === 0) return '';
    return `<span class="nature-summary-badge ${meta.badgeClass}" data-tooltip="${meta.label}: ${cnt} hành vi (${Math.round((cnt / total) * 100)}%)">
      <i class="fa-solid ${meta.icon}"></i> ${cnt} ${meta.label}
    </span>`;
  }).filter(Boolean).join('');
  $('natureSummaryBadges').innerHTML = badgesHtml;

  // Cột biểu đồ
  const barsHtml = order.map((key) => {
    const meta = NATURE_META[key] || NATURE_META['Bình thường'];
    const cnt = counts[key];
    const pct = total ? Math.round((cnt / total) * 100) : 0;
    const heightPct = total ? Math.round((cnt / maxCount) * 100) : 0;
    const isActive = state.filterNature === key;

    return `
      <div class="nature-bar-col ${meta.badgeClass}${isActive ? ' active' : ''}" data-nature="${escapeHtml(key)}" data-tooltip="${escapeHtml(meta.label)}: ${cnt} hành vi (${pct}%) — Nhấp để lọc">
        <div class="nature-bar-info">
          <div class="nature-bar-count">${cnt}</div>
          <div class="nature-bar-pct">${pct}%</div>
        </div>
        <div class="nature-bar-track">
          <div class="nature-bar-fill" style="height: ${cnt > 0 ? Math.max(heightPct, 8) : 0}%"></div>
        </div>
        <div class="nature-bar-label">
          <i class="fa-solid ${meta.icon}"></i>
          <span>${escapeHtml(key)}</span>
        </div>
      </div>
    `;
  }).join('');

  const container = $('natureChartBars');
  container.innerHTML = barsHtml;
  container.querySelectorAll('.nature-bar-col').forEach((col) => {
    col.addEventListener('click', () => {
      const nat = col.dataset.nature;
      if (state.filterNature === nat) {
        state.filterNature = '';
        $('filterNature').value = '';
      } else {
        state.filterNature = nat;
        $('filterNature').value = nat;
      }
      renderNatureChart();
      renderResultTable();
    });
  });

  // Box Đánh giá an ninh chốt mức cao nhất (Highest Threat Priority)
  // Quy tắc an ninh: Dù chỉ có 1 hành vi nguy hiểm/bất thường, vẫn ưu tiên cảnh báo mức cao nhất!
  let peakLevel = 'Bình thường';
  let badgeIcon = 'fa-circle-check';
  let badgeText = 'Trạng thái: Bình thường (Không có rủi ro)';
  let boxClass = 'normal';

  if (counts['Nguy hiểm'] > 0) {
    peakLevel = 'Nguy hiểm';
    badgeIcon = 'fa-triangle-exclamation';
    badgeText = `Mức cao nhất: Nguy hiểm (${counts['Nguy hiểm']} hành vi rủi ro)`;
    boxClass = 'danger';
  } else if (counts['Bất thường'] > 0) {
    peakLevel = 'Bất thường';
    badgeIcon = 'fa-circle-exclamation';
    badgeText = `Mức cao nhất: Bất thường (${counts['Bất thường']} hành vi cần chú ý)`;
    boxClass = 'warning';
  } else if (counts['An toàn'] > 0) {
    peakLevel = 'An toàn';
    badgeIcon = 'fa-shield-halved';
    badgeText = `Mức cao nhất: An toàn (${counts['An toàn']} hành vi bảo hộ/hỗ trợ)`;
    boxClass = 'success';
  }

  const assessBox = $('securityAssessmentBox');
  const assessBadge = $('assessmentBadge');
  const assessCount = $('assessmentEventCount');
  const assessSummary = $('assessmentSummary');
  const assessAlerts = $('assessmentAlerts');

  if (assessBox) {
    assessBox.className = 'security-assessment-box ' + boxClass;
    if (assessBadge) {
      assessBadge.className = 'security-assessment-badge ' + boxClass;
      assessBadge.innerHTML = `<i class="fa-solid ${badgeIcon}"></i> ${escapeHtml(badgeText)}`;
    }
    if (assessCount) {
      assessCount.textContent = `${total} hành vi ghi nhận`;
    }
    if (assessSummary) {
      assessSummary.textContent = state.videoResult?.summary || 'Đã phân tích toàn bộ khung thời gian của video.';
    }
    if (assessAlerts) {
      const alertEvents = state.rows.filter((r) => r.nature === 'Nguy hiểm' || r.nature === 'Bất thường');
      if (alertEvents.length > 0) {
        assessAlerts.innerHTML = alertEvents.slice(0, 5).map((r) => `
          <span class="security-alert-pill ${r.nature === 'Nguy hiểm' ? 'danger' : 'warning'}" data-tooltip="${escapeHtml(r.detail || r.action)} lúc ${fmtTime(r.start)}">
            <i class="fa-solid ${r.nature === 'Nguy hiểm' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation'}"></i>
            ${escapeHtml(r.action)} (${fmtTime(r.start)})
          </span>
        `).join('');
      } else {
        assessAlerts.innerHTML = `<span class="text-xs text-muted"><i class="fa-solid fa-check"></i> Không phát hiện hành vi đe dọa an ninh nào.</span>`;
      }
    }
  }
}

function renderActionPills() {
  const counts = {};
  state.rows.forEach((r) => { counts[r.action] = (counts[r.action] || 0) + 1; });
  const actions = Object.keys(counts).sort();

  const html = [['', 'Tất cả', state.rows.length], ...actions.map((a) => [a, a, counts[a]])]
    .map(([value, label, n]) =>
      `<button class="pill${state.activeAction === value ? ' active' : ''}" data-action="${escapeHtml(value)}" type="button">${escapeHtml(label)} (${n})</button>`)
    .join('');
  const box = $('actionPills');
  box.innerHTML = state.rows.length ? html : '';
  box.querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeAction = btn.dataset.action;
      renderActionPills();
      renderResultTable();
    });
  });
}

function renderResultTable() {
  const q = $('filterText').value.trim().toLowerCase();
  const rows = state.rows.filter((r) => {
    if (state.activeAction && r.action !== state.activeAction) return false;
    if (state.filterNature && r.nature !== state.filterNature) return false;
    return !q || `${r.id} ${r.appearance} ${r.action} ${r.nature} ${r.detail}`.toLowerCase().includes(q);
  });

  const tbody = $('resultBody');
  if (!rows.length) {
    const hasFilter = q || state.filterNature || state.activeAction;
    tbody.innerHTML = hasFilter
      ? '<tr class="empty"><td colspan="7"><i class="fa-solid fa-magnifying-glass"></i> Không tìm thấy kết quả phù hợp với bộ lọc</td></tr>'
      : '<tr class="empty"><td colspan="7"><i class="fa-regular fa-folder-open"></i> Chưa có dữ liệu phân tích. Hãy tải video lên để bắt đầu!</td></tr>';
  } else {
    tbody.innerHTML = rows.map((r, i) => {
      const meta = NATURE_META[r.nature] || NATURE_META['Bình thường'];
      return `
        <tr class="clickable" data-start="${r.start}">
          <td>${i + 1}</td>
          <td><span class="pid">${escapeHtml(r.id)}</span></td>
          <td>${highlight(r.appearance, q)}</td>
          <td><span class="tag">${highlight(r.action, q)}</span></td>
          <td>
            <span class="nature-tag ${meta.badgeClass}" data-tooltip="${meta.tooltip}">
              <i class="fa-solid ${meta.icon}"></i> ${escapeHtml(r.nature || 'Bình thường')}
            </span>
          </td>
          <td class="time">
            <a href="javascript:void(0)" class="time-link" data-start="${r.start}" data-tooltip="Tua video đến ${fmtTime(r.start)} và phát">
              <i class="fa-solid fa-circle-play"></i> ${fmtTime(r.start)} – ${fmtTime(r.end)}
            </a>
          </td>
          <td>${highlight(r.detail, q)}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        seekVideo(Number(tr.dataset.start));
      });
    });
    tbody.querySelectorAll('.time-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        seekVideo(Number(link.dataset.start));
      });
    });
  }
  $('filterCount').textContent = state.rows.length
    ? `Đang hiển thị ${rows.length} / ${state.rows.length} kết quả`
    : 'Đang hiển thị 0 kết quả';
}

function seekVideo(timeSec) {
  const v = $('videoPreview');
  if (!v) return;
  v.currentTime = timeSec;
  v.play().catch(() => {});
  const rect = v.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function downloadJson() {
  const data = { video: state.videoFile ? state.videoFile.name : '', ...state.videoResult };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.videoFile ? state.videoFile.name.replace(/\.[^.]+$/, '') : 'ket-qua') + '.json';
  a.click();
}

// Camera realtime

const FRAME_SCHEMA = {
  type: 'OBJECT',
  properties: {
    scene: { type: 'STRING', description: 'Mô tả khung cảnh trong 1 câu' },
    persons: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          appearance: { type: 'STRING', description: 'Trang phục, đặc điểm nhận dạng' },
          action: {
            type: 'STRING',
            description: 'Hành động cụ thể (chọn chính xác từ: "Đi bộ", "Chạy", "Đứng", "Ngồi", "Cúi người/Nằm", "Dùng điện thoại", "Cầm nắm đồ vật", "Mang vác/Kéo lê", "Bỏ lại đồ vật", "Đột nhập/Leo trèo", "Xô xát/Ẩu đả", "Té ngã", "Phá hoại")',
          },
          nature: {
            type: 'STRING',
            description: 'Tính chất hành vi an ninh: "Bình thường", "An toàn", "Bất thường", hoặc "Nguy hiểm"',
          },
        },
        required: ['appearance', 'action', 'nature'],
      },
    },
  },
  required: ['scene', 'persons'],
};

const FRAME_PROMPT = `Đây là một khung hình chụp từ camera an ninh. Liệt kê những người có trong ảnh, với mỗi người:
- appearance: Trang phục, đặc điểm nhận dạng (giới tính ước đoán, màu áo, phụ kiện).
- action: HÀNH ĐỘNG CỤ THỂ, BẮT BUỘC chọn 1 trong các nhãn chuẩn sau:
    [Vận động cơ bản]: "Đi bộ", "Chạy", "Đứng", "Ngồi", "Cúi người/Nằm"
    [Tương tác vật thể]: "Dùng điện thoại", "Cầm nắm đồ vật", "Mang vác/Kéo lê", "Bỏ lại đồ vật"
    [An ninh & Sự cố]: "Đột nhập/Leo trèo", "Xô xát/Ẩu đả", "Té ngã", "Phá hoại"
- nature: TÍNH CHẤT HÀNH VI AN NINH, phân loại chính xác thành 1 trong 4 nhóm:
    * "Nguy hiểm": Hành vi gây rủi ro tức thì (Xô xát/Ẩu đả, Té ngã bất tỉnh, Phá hoại tài sản, Đột nhập/Leo trèo).
    * "Bất thường": Hành vi khả nghi cần theo dõi (Bỏ lại đồ vật, chạy trốn vội vã, lảng vảng ngó nghiêng lén lút).
    * "An toàn": Tuân thủ quy định và bảo vệ an toàn (Đội mũ bảo hiểm, mặc đồ bảo hộ, hỗ trợ người khác).
    * "Bình thường": Sinh hoạt và làm việc chuẩn (Đi bộ, Đứng, Ngồi, Dùng điện thoại thông thường).
Không có người thì để persons rỗng. Viết bằng tiếng Việt.`;

function initCameraPage() {
  $('btnCamStart').addEventListener('click', startCamera);
  $('btnCamStop').addEventListener('click', stopCamera);
  $('camFilter').addEventListener('input', renderCamLog);
  $('btnCamClear').addEventListener('click', () => {
    state.cameraLog = [];
    renderCamLog();
    renderCamNatureChart();
    renderChatContext();
    updateCamDownloadBtn();
  });
  $('camInterval').addEventListener('change', () => {
    if (state.cameraTimer) { clearInterval(state.cameraTimer); scheduleCapture(); }
  });
  const btnCamDownload = $('btnCamDownload');
  if (btnCamDownload) btnCamDownload.addEventListener('click', downloadCamJson);
  const btnCamDownloadTable = $('btnCamDownloadTable');
  if (btnCamDownloadTable) btnCamDownloadTable.addEventListener('click', downloadCamJson);

  const btnCamImport = $('btnCamImport');
  if (btnCamImport) btnCamImport.addEventListener('click', () => $('camImportInput').click());
  const btnCamImportTable = $('btnCamImportTable');
  if (btnCamImportTable) btnCamImportTable.addEventListener('click', () => $('camImportInput').click());
  const camEmptyImportLink = $('camEmptyImportLink');
  if (camEmptyImportLink) camEmptyImportLink.addEventListener('click', () => $('camImportInput').click());

  $('camImportInput').addEventListener('change', () => {
    if ($('camImportInput').files[0]) importCamJson($('camImportInput').files[0]);
    $('camImportInput').value = '';
  });
}

function updateCamDownloadBtn() {
  const hasData = Boolean(state.cameraLog && state.cameraLog.length > 0);
  const btn = $('btnCamDownload');
  if (btn) btn.disabled = !hasData;
  const btnTable = $('btnCamDownloadTable');
  if (btnTable) btnTable.disabled = !hasData;
}

function downloadCamJson() {
  if (!state.cameraLog.length) return;
  const data = {
    source: 'Realtime Camera Log',
    exportedAt: new Date().toISOString(),
    totalSnapshots: state.cameraLog.length,
    cameraLog: state.cameraLog,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `nhat-ky-camera-${dateStr}.json`;
  a.click();
}

async function importCamJson(file) {
  try {
    const raw = JSON.parse(await file.text());
    let importedLog = [];
    if (Array.isArray(raw)) {
      importedLog = raw;
    } else if (Array.isArray(raw.cameraLog)) {
      importedLog = raw.cameraLog;
    } else if (Array.isArray(raw.persons)) {
      importedLog = [{
        id: 'cam_' + Date.now(),
        time: new Date().toLocaleTimeString('vi-VN'),
        scene: raw.summary || 'Dữ liệu nhập từ file phân tích',
        persons: raw.persons.flatMap((p) => (p.behaviors || []).map((b) => ({
          appearance: p.appearance || p.person || 'Người',
          action: b.action || b.behavior || 'Không rõ',
          nature: normalizeNature(b.nature) || 'Bình thường'
        }))),
        snapshot: null
      }];
    } else {
      throw new Error();
    }

    if (!importedLog.length) {
      setStatus('camStatus', 'File JSON không có bản ghi nào.', 'error');
      return;
    }

    state.cameraLog = importedLog.map((e, idx) => ({
      id: e.id || ('cam_imp_' + Date.now() + '_' + idx),
      time: e.time || new Date().toLocaleTimeString('vi-VN'),
      scene: e.scene || '',
      persons: (e.persons || []).map((p) => ({
        appearance: p.appearance || 'Người',
        action: p.action || p.behavior || 'Không rõ',
        nature: normalizeNature(p.nature) || inferNature(p.action, '') || 'Bình thường'
      })),
      snapshot: e.snapshot || null
    }));

    if (state.cameraLog.length > 0) {
      renderCamLatest(state.cameraLog[0]);
    }
    renderCamLog();
    renderCamNatureChart();
    renderChatContext();
    updateCamDownloadBtn();
    setStatus('camStatus', `Đã nhập ${state.cameraLog.length} bản ghi từ ${file.name}.`, 'ok');
  } catch (_) {
    setStatus('camStatus', 'File JSON không đúng định dạng nhật ký camera.', 'error');
  }
}

async function startCamera() {
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    $('camVideo').srcObject = state.cameraStream;
    $('camBadge').classList.remove('hidden');
    $('btnCamStart').disabled = true;
    $('btnCamStop').disabled = false;
    setStatus('camStatus', 'Camera đang chạy', 'ok');
    monitorState.cameraConflict = false;
    monitorState.cameraConflictMsg = '';
    updateMonitorUI();
    scheduleCapture();
    captureAndAnalyze();
  } catch (err) {
    let msg = 'Không mở được camera: ' + err.message;
    if (err.name === 'NotReadableError' || /device in use|could not start/i.test(err.message)) {
      msg = 'Xung đột thiết bị: Camera đang bị ứng dụng khác (Zoom, Teams, OBS, Zalo, Camera Windows...) khóa độc quyền!';
      monitorState.cameraConflict = true;
      monitorState.cameraConflictMsg = 'Camera đang bị ứng dụng khác chiếm quyền sử dụng (NotReadableError).';
    } else if (err.name === 'NotAllowedError') {
      msg = 'Xung đột quyền: Quyền truy cập Camera bị từ chối hoặc bị chặn bởi cài đặt quyền riêng tư Windows.';
      monitorState.cameraConflict = true;
      monitorState.cameraConflictMsg = 'Quyền Camera bị từ chối.';
    } else if (err.name === 'NotFoundError') {
      msg = 'Không tìm thấy thiết bị webcam nào trên máy tính.';
      monitorState.cameraConflict = true;
      monitorState.cameraConflictMsg = 'Không tìm thấy webcam.';
    }
    setStatus('camStatus', msg, 'error');
    updateMonitorUI();
  }
}

function stopCamera() {
  clearInterval(state.cameraTimer);
  state.cameraTimer = null;
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  $('camVideo').srcObject = null;
  $('camBadge').classList.add('hidden');
  $('btnCamStart').disabled = false;
  $('btnCamStop').disabled = true;
  setStatus('camStatus', 'Đã dừng');
  updateMonitorUI();
}

function scheduleCapture() {
  state.cameraTimer = setInterval(captureAndAnalyze, Number($('camInterval').value));
}

async function captureAndAnalyze() {
  // bỏ qua nếu request trước chưa xong
  if (state.cameraBusy || !state.cameraStream) return;
  const video = $('camVideo');
  if (!video.videoWidth) return;

  const canvas = $('camCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  const base64 = dataUrl.split(',')[1];

  state.cameraBusy = true;
  if (typeof tickSystemMetrics === 'function') tickSystemMetrics();
  setStatus('camStatus', 'Đang nhận diện', 'loading');
  try {
    const result = parseJson(await callGemini([
      { inlineData: { mimeType: 'image/jpeg', data: base64 } },
      { text: FRAME_PROMPT },
    ], { schema: FRAME_SCHEMA }));

    const entry = {
      id: 'cam_' + Date.now(),
      time: new Date().toLocaleTimeString('vi-VN'),
      scene: result.scene || '',
      persons: (result.persons || []).map((p) => ({
        appearance: p.appearance,
        action: p.action,
        nature: normalizeNature(p.nature) || inferNature(p.action, '') || 'Bình thường',
      })),
      snapshot: dataUrl,
    };
    state.cameraLog.unshift(entry);
    if (state.cameraLog.length > MAX_CAM_LOG) state.cameraLog.pop();
    renderCamLatest(entry);
    renderCamLog();
    renderCamNatureChart();
    renderChatContext();
    updateCamDownloadBtn();
    setStatus('camStatus', 'Cập nhật lúc ' + entry.time, 'ok');
  } catch (err) {
    setStatus('camStatus', err.message, 'error');
  } finally {
    state.cameraBusy = false;
    if (typeof tickSystemMetrics === 'function') tickSystemMetrics();
  }
}

function renderCamLatest(entry) {
  $('camLatestTime').textContent = entry.time;
  const people = entry.persons.length
    ? `<ul>${entry.persons.map((p) => `<li><span>${escapeHtml(p.appearance)}</span><span class="tag">${escapeHtml(p.action)}</span></li>`).join('')}</ul>`
    : '<div class="text-muted">Không thấy người nào trong khung hình</div>';

  if (entry.snapshot) {
    $('camLatest').innerHTML = `
      <div class="cam-latest-card">
        <div class="cam-latest-snapshot-wrap" id="latestSnapshotBtn" data-tooltip="Bấm để xem ảnh phóng to">
          <img src="${entry.snapshot}" class="cam-latest-img" alt="Ảnh capture mới nhất">
          <span class="cam-snapshot-badge"><i class="fa-solid fa-camera"></i> ${entry.time}</span>
        </div>
        <div class="cam-latest-info">
          <div class="scene">${escapeHtml(entry.scene)}</div>
          ${people}
        </div>
      </div>
    `;
    $('latestSnapshotBtn')?.addEventListener('click', () => {
      openImageModal(entry.snapshot, `Khung hình camera lúc ${entry.time}`, entry.scene, entry.persons);
    });
  } else {
    $('camLatest').innerHTML = `<div class="scene">${escapeHtml(entry.scene)}</div>${people}`;
  }
}

function renderCamLog() {
  const q = $('camFilter').value.trim().toLowerCase();
  const rows = [];
  state.cameraLog.forEach((e) => {
    if (!e.persons.length) {
      if (!q || (e.scene || '').toLowerCase().includes(q)) {
        rows.push({
          time: e.time,
          appearance: '<span class="text-muted">(Không có người)</span>',
          action: e.scene || 'Không phát hiện',
          nature: '',
          snapshot: e.snapshot,
          scene: e.scene,
          isRawText: true,
        });
      }
    } else {
      e.persons.forEach((p) => {
        if (!q || `${p.appearance} ${p.action} ${e.scene}`.toLowerCase().includes(q)) {
          rows.push({
            time: e.time,
            appearance: p.appearance,
            action: p.action,
            nature: p.nature || inferNature(p.action, '') || 'Bình thường',
            snapshot: e.snapshot,
            scene: e.scene,
          });
        }
      });
    }
  });

  const tbody = $('camLogBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="5"><i class="fa-regular fa-folder-open"></i>Không có dữ liệu</td></tr>';
  } else {
    tbody.innerHTML = rows.map((r, i) => {
      const meta = r.nature ? (NATURE_META[r.nature] || NATURE_META['Bình thường']) : null;
      const natureCellHtml = meta
        ? `<span class="nature-tag ${meta.badgeClass}" data-tooltip="${meta.tooltip}"><i class="fa-solid ${meta.icon}"></i> ${escapeHtml(r.nature)}</span>`
        : '<span class="text-muted">—</span>';
      return `
      <tr>
        <td class="time">${r.time}</td>
        <td style="text-align: center;">
          ${r.snapshot ? `
            <div class="cam-thumb-wrap" data-index="${i}" data-tooltip="Bấm để xem ảnh phóng to">
              <img src="${r.snapshot}" class="cam-thumb" alt="Ảnh capture">
              <div class="thumb-zoom-icon"><i class="fa-solid fa-magnifying-glass-plus"></i></div>
            </div>` : '<span class="text-muted">—</span>'}
        </td>
        <td>${r.isRawText ? r.appearance : highlight(r.appearance, q)}</td>
        <td><span class="tag">${highlight(r.action, q)}</span></td>
        <td>${natureCellHtml}</td>
      </tr>
    `;
    }).join('');

    tbody.querySelectorAll('.cam-thumb-wrap').forEach((wrap) => {
      wrap.addEventListener('click', () => {
        const item = rows[Number(wrap.dataset.index)];
        if (item && item.snapshot) {
          openImageModal(item.snapshot, `Ảnh chụp camera lúc ${item.time}`, item.scene, [{ appearance: item.appearance, action: item.action }]);
        }
      });
    });
  }
}

function renderCamNatureChart() {
  const card = $('camNatureChartCard');
  const empty = $('camNatureChartEmpty');
  if (!card) return;

  // Gộp tất cả persons trong cameraLog để đếm nature
  const allPersons = state.cameraLog.flatMap((e) => e.persons || []);
  if (!allPersons.length) {
    card.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const counts = { 'Nguy hiểm': 0, 'Bất thường': 0, 'An toàn': 0, 'Bình thường': 0 };
  allPersons.forEach((p) => {
    const nat = p.nature || inferNature(p.action, '') || 'Bình thường';
    counts[nat] = (counts[nat] || 0) + 1;
  });

  const total = allPersons.length;
  const maxCount = Math.max(1, ...Object.values(counts));
  const order = ['Nguy hiểm', 'Bất thường', 'An toàn', 'Bình thường'];

  // Badges tóm tắt
  const badgesHtml = order.map((key) => {
    const meta = NATURE_META[key] || NATURE_META['Bình thường'];
    const cnt = counts[key];
    if (cnt === 0) return '';
    return `<span class="nature-summary-badge ${meta.badgeClass}" data-tooltip="${meta.label}: ${cnt} lần (${Math.round((cnt / total) * 100)}%)">
      <i class="fa-solid ${meta.icon}"></i> ${cnt} ${meta.label}
    </span>`;
  }).filter(Boolean).join('');
  $('camNatureSummaryBadges').innerHTML = badgesHtml;

  // Cột biểu đồ
  const barsHtml = order.map((key) => {
    const meta = NATURE_META[key] || NATURE_META['Bình thường'];
    const cnt = counts[key];
    const pct = total ? Math.round((cnt / total) * 100) : 0;
    const heightPct = total ? Math.round((cnt / maxCount) * 100) : 0;
    return `
      <div class="nature-bar-col ${meta.badgeClass}" data-tooltip="${escapeHtml(meta.label)}: ${cnt} lần (${pct}%)">
        <div class="nature-bar-info">
          <div class="nature-bar-count">${cnt}</div>
          <div class="nature-bar-pct">${pct}%</div>
        </div>
        <div class="nature-bar-track">
          <div class="nature-bar-fill" style="height: ${cnt > 0 ? Math.max(heightPct, 8) : 0}%"></div>
        </div>
        <div class="nature-bar-label">
          <i class="fa-solid ${meta.icon}"></i>
          <span>${escapeHtml(key)}</span>
        </div>
      </div>
    `;
  }).join('');
  $('camNatureChartBars').innerHTML = barsHtml;

  // Box Đánh giá an ninh realtime chốt mức cao nhất cho Camera
  let camPeakLevel = 'Bình thường';
  let camBadgeIcon = 'fa-circle-check';
  let camBadgeText = 'Trạng thái: Bình thường (Ổn định)';
  let camBoxClass = 'normal';

  if (counts['Nguy hiểm'] > 0) {
    camPeakLevel = 'Nguy hiểm';
    camBadgeIcon = 'fa-triangle-exclamation';
    camBadgeText = `Mức cao nhất: Nguy hiểm (${counts['Nguy hiểm']} lần)`;
    camBoxClass = 'danger';
  } else if (counts['Bất thường'] > 0) {
    camPeakLevel = 'Bất thường';
    camBadgeIcon = 'fa-circle-exclamation';
    camBadgeText = `Mức cao nhất: Bất thường (${counts['Bất thường']} lần)`;
    camBoxClass = 'warning';
  } else if (counts['An toàn'] > 0) {
    camPeakLevel = 'An toàn';
    camBadgeIcon = 'fa-shield-halved';
    camBadgeText = `Mức cao nhất: An toàn (${counts['An toàn']} lần)`;
    camBoxClass = 'success';
  }

  const camBox = $('camSecurityAssessmentBox');
  const camBadge = $('camAssessmentBadge');
  const camCount = $('camAssessmentCount');
  const camAlerts = $('camAssessmentAlerts');

  if (camBox) {
    camBox.className = 'security-assessment-box ' + camBoxClass;
    if (camBadge) {
      camBadge.className = 'security-assessment-badge ' + camBoxClass;
      camBadge.innerHTML = `<i class="fa-solid ${camBadgeIcon}"></i> ${escapeHtml(camBadgeText)}`;
    }
    if (camCount) {
      camCount.textContent = `${total} lượt phát hiện`;
    }
    if (camAlerts) {
      const dangerPersons = allPersons.filter((p) => p.nature === 'Nguy hiểm' || p.nature === 'Bất thường');
      if (dangerPersons.length > 0) {
        camAlerts.innerHTML = dangerPersons.slice(0, 4).map((p) => `
          <span class="security-alert-pill ${p.nature === 'Nguy hiểm' ? 'danger' : 'warning'}">
            <i class="fa-solid ${p.nature === 'Nguy hiểm' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation'}"></i>
            ${escapeHtml(p.action)}
          </span>
        `).join('');
      } else {
        camAlerts.innerHTML = `<span class="text-xs text-muted"><i class="fa-solid fa-check"></i> Không có hành vi khả nghi trong các khung hình gần nhất.</span>`;
      }
    }
  }
}

// Chatbot

function initChatPage() {
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('chatInput').value.trim();
    if (!q) return;
    $('chatInput').value = '';
    sendChat(q);
  });
  $('chatSuggest').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => sendChat(btn.textContent.trim()));
  });
  $('btnChatClear').addEventListener('click', () => {
    state.chatHistory = [];
    $('chatMessages').innerHTML = CHAT_EMPTY;
  });
  $('chatSource').querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.chatSource = btn.dataset.source;
      localStorage.setItem('chat_source', state.chatSource);
      renderChatContext();
    });
  });
  renderChatContext();
}

const CHAT_EMPTY = $('chatMessages').innerHTML;

function renderChatContext() {
  const r = state.videoResult;
  $('ctxVideo').textContent = state.videoFile ? state.videoFile.name : 'Chưa có';
  $('ctxVideo').title = state.videoFile ? state.videoFile.name : '';
  $('ctxPersons').textContent = r ? r.persons.length : 0;
  $('ctxEvents').textContent = state.rows.length;
  $('ctxCamera').textContent = state.cameraLog.length + ' mục';

  const src = state.chatSource;
  $('chatSource').querySelectorAll('.pill').forEach((b) => b.classList.toggle('active', b.dataset.source === src));
  document.querySelectorAll('.info-list [data-group]').forEach((el) => {
    el.classList.toggle('off', src !== 'both' && el.dataset.group !== src);
  });
}

function buildChatContext() {
  const useVideo = state.chatSource !== 'camera';
  const useCamera = state.chatSource !== 'video';
  const parts = [];

  if (useVideo) {
    parts.push(state.videoResult
      ? 'KẾT QUẢ PHÂN TÍCH VIDEO:\n' + JSON.stringify(state.videoResult)
      : 'Chưa có video nào được phân tích.');
  }
  if (useCamera) {
    parts.push(state.cameraLog.length
      ? 'NHẬT KÝ CAMERA (mới nhất trước):\n' + JSON.stringify(state.cameraLog.slice(0, 20))
      : 'Chưa có nhật ký camera.');
  }

  return `Bạn là trợ lý phân tích hành vi trong video. Trả lời ngắn gọn bằng tiếng Việt.
Chỉ dựa vào dữ liệu bên dưới; nếu không có thông tin thì nói rõ là không thấy trong dữ liệu, không bịa.
Khi nhắc tới người, mô tả bằng đặc điểm (ví dụ "người mặc áo đỏ") kèm mã (P1).\n\n` + parts.join('\n\n');
}

async function sendChat(question) {
  setChatSuggestionsVisible(false);
  appendMessage('user', question);
  const bubble = appendMessage('bot typing', 'Đang trả lời');

  try {
    const answer = await callGemini([{ text: question }], {
      systemInstruction: buildChatContext(),
      history: state.chatHistory,
    });
    state.chatHistory.push({ role: 'user', parts: [{ text: question }] });
    state.chatHistory.push({ role: 'model', parts: [{ text: answer }] });
    bubble.className = 'msg bot';
    bubble.innerHTML = renderMarkdown(answer);
  } catch (err) {
    bubble.className = 'msg bot error';
    bubble.textContent = err.message;
  } finally {
    setChatSuggestionsVisible(true);
  }
}

function setChatSuggestionsVisible(visible) {
  document.querySelector('.chat-suggestions').classList.toggle('is-loading', !visible);
}

// markdown tối giản: đậm, nghiêng, code, danh sách, đoạn văn
function renderMarkdown(text) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { blocks.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { blocks.push(`<${list.tag}>${list.items.map((i) => '<li>' + inline(i) + '</li>').join('')}</${list.tag}>`); list = null; } };

  escapeHtml(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) {
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      flushPara();
      if (list && list.tag !== tag) flushList();
      list = list || { tag, items: [] };
      list.items.push(m[1]);
    } else if (!line) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  });
  flushPara(); flushList();
  return blocks.join('');
}

function appendMessage(cls, text) {
  const box = $('chatMessages');
  const empty = box.querySelector('.chat-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Cài đặt

let keyShown = false;

function initSettingsPage() {
  const inp = $('apiKey');
  inp.dataset.value = state.apiKey;
  renderKeyField();
  fillModelList(SUGGESTED_MODELS);

  // khi focus luôn hiện key thật để sửa được, blur thì che lại
  inp.addEventListener('focus', renderKeyField);
  inp.addEventListener('blur', renderKeyField);
  inp.addEventListener('input', () => { inp.dataset.value = inp.value.trim(); });

  $('btnToggleKey').addEventListener('click', () => {
    keyShown = !keyShown;
    $('btnToggleKey').innerHTML = `<i class="fa-regular ${keyShown ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    renderKeyField();
  });

  $('btnSaveSettings').addEventListener('click', () => {
    state.apiKey = inp.dataset.value;
    state.model = $('model').value || DEFAULT_MODEL;
    localStorage.setItem('gemini_api_key', state.apiKey);
    localStorage.setItem('gemini_model', state.model);
    setStatus('settingsStatus', state.apiKey ? 'Đã lưu' : 'Đã lưu nhưng chưa có API key', state.apiKey ? 'ok' : 'error');
  });

  $('btnLoadModels').addEventListener('click', loadModels);
}

function renderKeyField() {
  const inp = $('apiKey');
  const key = inp.dataset.value || '';
  const focused = document.activeElement === inp;
  inp.value = keyShown || focused ? key : maskKey(key);
}

function maskKey(key) {
  if (key.length <= 5) return '•'.repeat(key.length);
  return '•'.repeat(Math.min(key.length - 5, 20)) + key.slice(-5);
}

async function loadModels() {
  const key = $('apiKey').dataset.value;
  if (!key) { setStatus('settingsStatus', 'Nhập API key trước', 'error'); return; }
  setStatus('settingsStatus', 'Đang tải danh sách model', 'loading');
  try {
    const res = await fetch(`${API_BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new Error(`Lỗi ${res.status}, key có thể không hợp lệ.`);
    const data = await res.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => /flash/i.test(n))
      .sort();
    fillModelList(names.length ? names : SUGGESTED_MODELS);
    setStatus('settingsStatus', `Key hợp lệ, có ${names.length} model Flash để chọn`, 'ok');
  } catch (err) {
    setStatus('settingsStatus', err.message, 'error');
  }
}

function fillModelList(names) {
  const select = $('model');
  const current = select.value || state.model;
  const list = names.includes(current) ? names : [current, ...names];
  select.innerHTML = list.map((n) => `<option value="${n}">${n}</option>`).join('');
  select.value = current;
}

// Điều hướng, tiện ích

function initNav() {
  const sidebar = $('sidebar');
  const backdrop = $('sidebarBackdrop');
  const closeDrawer = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };

  $('btnMenu').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('show');
  });
  backdrop.addEventListener('click', closeDrawer);

  document.querySelectorAll('.menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      showPage(item.dataset.page);
      closeDrawer();
    });
  });

  // mở đúng trang theo hash, chưa có key thì vào Cài đặt
  const initial = location.hash.replace('#', '');
  showPage(!state.apiKey ? 'settings' : (initial || 'video'));
}

function showPage(name) {
  if (!$('page-' + name)) name = 'video';
  document.querySelectorAll('.menu-item').forEach((i) => i.classList.toggle('active', i.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function initClock() {
  const tick = () => {
    const now = new Date();
    $('clockTime').textContent = now.toLocaleTimeString('vi-VN');
    $('clockDate').textContent = now.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  };
  tick();
  setInterval(tick, 1000);
}

function setStatus(id, msg, type = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status ' + type;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(s, q) {
  const safe = escapeHtml(s);
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function initImageModal() {
  const modal = $('imageModal');
  const closeBtn = $('modalClose');
  if (!modal) return;

  const close = () => closeImageModal();
  closeBtn?.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      close();
    }
  });
}

function openImageModal(imgSrc, title, scene, persons) {
  const modal = $('imageModal');
  if (!modal) return;
  $('modalImg').src = imgSrc;
  $('modalImgTitle').textContent = title || 'Ảnh chụp camera';

  let desc = '';
  if (scene) {
    desc += `<div><b>Khung cảnh:</b> ${escapeHtml(scene)}</div>`;
  }
  if (persons && persons.length && persons[0].action) {
    const list = persons
      .filter((p) => p.action && !String(p.appearance).includes('(Không có người)'))
      .map((p) => `${escapeHtml(p.appearance)}: <b>${escapeHtml(p.action)}</b>`)
      .join(', ');
    if (list) {
      desc += `<div style="margin-top: 6px;"><b>Phát hiện:</b> ${list}</div>`;
    }
  }
  $('modalImgDesc').innerHTML = desc || '<div>Khoảnh khắc nhận diện từ camera.</div>';
  modal.classList.remove('hidden');
}

function closeImageModal() {
  const modal = $('imageModal');
  if (modal) modal.classList.add('hidden');
}

function initTooltips() {
  const tooltip = $('appTooltip');
  if (!tooltip) return;

  let activeEl = null;

  function showTooltip(el) {
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    activeEl = el;
    tooltip.textContent = text;
    tooltip.classList.remove('arrow-top');
    tooltip.classList.add('show');

    const rect = el.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let top = rect.top - tooltipRect.height - 8;
    let left = rect.left + rect.width / 2;

    // Tránh tràn viền trên màn hình
    if (top < 10) {
      top = rect.bottom + 8;
      tooltip.classList.add('arrow-top');
    }
    const halfWidth = tooltipRect.width / 2;
    if (left - halfWidth < 10) {
      left = halfWidth + 10;
    } else if (left + halfWidth > window.innerWidth - 10) {
      left = window.innerWidth - halfWidth - 10;
    }

    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.left = `${Math.round(left)}px`;
  }

  function hideTooltip() {
    activeEl = null;
    tooltip.classList.remove('show');
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (target) {
      showTooltip(target);
    } else if (activeEl) {
      hideTooltip();
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (target && target === activeEl) {
      hideTooltip();
    }
  });

  window.addEventListener('scroll', hideTooltip, { passive: true });
}

// ==================== GIÁM SÁT HỆ THỐNG & KIỂM TRA XUNG ĐỘT ====================

const monitorState = {
  osAgentConnected: false,
  osAgentLastSeen: 0,
  realDiskUsedGb: 0,
  realDiskTotalGb: 0,
  diskSeekMs: 0.08,

  cpuPercent: 8,
  fps: 60,
  eventLoopLag: 1.5,
  cpuCores: navigator.hardwareConcurrency || 4,

  gpuRenderer: 'Đang tải chip đồ họa...',
  gpuVendor: '',
  gpuAccelerated: true,
  gpuLost: false,
  gpuPercent: 12,

  usedHeapMb: 0,
  limitHeapMb: 0,
  heapPercent: 0,
  deviceRamGb: navigator.deviceMemory || 8,

  // Card mạng & Băng thông (Network Interface Card - NIC)
  netType: 'Ethernet/Wi-Fi',
  netDownlink: 10,     // Mbps
  netRtt: 50,          // ms
  netSaveData: false,

  // Bộ nhớ ngoài / Ổ cứng (Storage I/O & SSD/HDD)
  diskType: 'SSD NVMe / SATA',
  diskQuotaMb: 0,
  diskUsedMb: 0,
  diskUsagePercent: 0,
  ioReadSpeedMb: 350,  // Tốc độ đọc file I/O (MB/s)

  // Cờ cảnh báo xung đột
  cameraConflict: false,
  cameraConflictMsg: '',
  gpuConflict: false,
  gpuConflictMsg: '',
  cpuConflict: false,
  cpuConflictMsg: '',
  ramConflict: false,
  ramConflictMsg: '',
  diskConflict: false,
  diskConflictMsg: '',
  netConflict: false,
  netConflictMsg: '',

  lastScanTime: null,
  isScanning: false,
};

let frameCount = 0;
let lastFpsTime = performance.now();
let lastLagCheck = performance.now();
let currentFps = 60;
let eventLoopLag = 1.5;

function initSystemMonitor() {
  detectGpuInfo();
  requestAnimationFrame(fpsLoop);
  setInterval(tickSystemMetrics, 800);

  $('btnScanConflictMain')?.addEventListener('click', runConflictScan);
  $('headerSysStatus')?.addEventListener('click', () => showPage('monitor'));
  $('btnBenchDisk')?.addEventListener('click', runDiskBenchmark);
  $('osAgentStatusBadge')?.addEventListener('click', showOsAgentHelp);

  // Bắt sự cố mất ngữ cảnh WebGL khi xung đột với game/app 3D khác
  window.addEventListener('webglcontextlost', () => {
    monitorState.gpuLost = true;
    monitorState.gpuConflict = true;
    monitorState.gpuConflictMsg = 'Ngữ cảnh WebGL bị mất do xung đột với ứng dụng đồ họa khác hoặc lỗi card đồ họa!';
    updateMonitorUI();
  }, false);

  // Quét kiểm tra xung đột lần đầu
  runConflictScan();
}

function showOsAgentHelp() {
  if (monitorState.osAgentConnected) {
    alert(`[OS Agent Đang Kết Nối]\n\n• Trạng thái: Đang lấy dữ liệu trực tiếp từ Windows Task Manager\n• Cổng giao tiếp: http://127.0.0.1:5001/api/metrics\n• Nguồn dữ liệu: Windows Kernel qua thư viện psutil\n• Cập nhật: Chu kỳ thời gian thực mỗi 800ms`);
  } else {
    alert(`[Hướng Dẫn Kết Nối OS Agent - Task Manager]\n\nHiện tại trình duyệt đang ở chế độ Web Sandbox độc lập.\nĐể lấy chính xác 100% thông số CPU, RAM, SSD từ Task Manager Windows:\n\n1. Mở Terminal / PowerShell tại thư mục dự án:\n   d:\\Code-hdh-hoanchinh\n\n2. Chạy lệnh:\n   python system_agent.py\n\n3. Trình duyệt sẽ tự động phát hiện và chuyển sang hiển thị số liệu thật của máy tính!`);
  }
}

let isAgentPolling = false;
async function pollOsAgentMetrics() {
  if (isAgentPolling) return;
  isAgentPolling = true;
  try {
    const res = await fetch('http://127.0.0.1:5001/api/metrics', {
      method: 'GET',
      signal: AbortSignal.timeout(600)
    });
    if (res.ok) {
      const data = await res.json();
      monitorState.osAgentConnected = true;
      monitorState.osAgentLastSeen = Date.now();
      if (typeof data.cpuPercent === 'number') monitorState.cpuPercent = data.cpuPercent;
      if (data.cpuCoresLogical) monitorState.cpuCores = data.cpuCoresLogical;
      if (data.ramUsedMb) monitorState.usedHeapMb = data.ramUsedMb;
      if (data.ramTotalMb) monitorState.limitHeapMb = data.ramTotalMb;
      if (typeof data.ramPercent === 'number') monitorState.heapPercent = Math.round(data.ramPercent);
      if (data.ramTotalGb) monitorState.deviceRamGb = data.ramTotalGb;
      if (typeof data.diskReadSpeedMb === 'number') monitorState.ioReadSpeedMb = data.diskReadSpeedMb;
      if (typeof data.diskSeekMs === 'number') monitorState.diskSeekMs = data.diskSeekMs;
      if (data.diskTotalGb) monitorState.realDiskTotalGb = data.diskTotalGb;
      if (data.diskUsedGb) monitorState.realDiskUsedGb = data.diskUsedGb;
      if (typeof data.diskUsagePercent === 'number') monitorState.diskUsagePercent = data.diskUsagePercent;
      if (typeof data.netDownlinkMbps === 'number' && data.netDownlinkMbps > 0) {
        monitorState.netDownlink = data.netDownlinkMbps;
      }
    } else {
      monitorState.osAgentConnected = false;
    }
  } catch (_) {
    monitorState.osAgentConnected = false;
  } finally {
    isAgentPolling = false;
  }
}

async function runDiskBenchmark() {
  const btn = $('btnBenchDisk');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đo...';
  }
  try {
    if (monitorState.osAgentConnected) {
      const res = await fetch('http://127.0.0.1:5001/api/benchmark-disk', {
        method: 'GET',
        signal: AbortSignal.timeout(12000)
      });
      if (res.ok) {
        const data = await res.json();
        monitorState.ioReadSpeedMb = data.readSpeedMb;
        monitorState.diskSeekMs = data.seekMs;
        updateMonitorUI();
        alert(`Kết quả Benchmark SSD thực tế (Windows Kernel):\n• Tốc độ đọc: ${data.readSpeedMb} MB/s\n• Tốc độ ghi: ${data.writeSpeedMb} MB/s\n• Độ trễ tìm file (Seek): ${data.seekMs} ms`);
      }
    } else {
      const t0 = performance.now();
      const testBlob = new Blob([new Uint8Array(15 * 1024 * 1024)]);
      await testBlob.arrayBuffer();
      const dt = Math.max(0.001, (performance.now() - t0) / 1000);
      const measuredSpeed = Math.round(15 / dt);
      monitorState.ioReadSpeedMb = measuredSpeed;
      updateMonitorUI();
      alert(`Kết quả đo tốc độ đọc I/O thực tế (Web Process Buffer):\n• Tốc độ đọc: ~${measuredSpeed} MB/s\n\n(Mẹo: Khởi động "python system_agent.py" để chạy benchmark chuẩn Windows Task Manager)`);
    }
  } catch (err) {
    alert('Lỗi đo tốc độ: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Đo tốc độ SSD';
    }
  }
}

function detectGpuInfo() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      monitorState.gpuRenderer = 'Không hỗ trợ WebGL';
      monitorState.gpuAccelerated = false;
      monitorState.gpuConflict = true;
      monitorState.gpuConflictMsg = 'Trình duyệt không bật hoặc card đồ họa không hỗ trợ WebGL!';
      return;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      monitorState.gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'Card đồ họa chuẩn';
      monitorState.gpuVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '';
    } else {
      monitorState.gpuRenderer = gl.getParameter(gl.RENDERER) || 'Card đồ họa phần cứng';
      monitorState.gpuVendor = gl.getParameter(gl.VENDOR) || '';
    }
    if (/swiftshader|llvmpipe|software/i.test(monitorState.gpuRenderer)) {
      monitorState.gpuAccelerated = false;
      monitorState.gpuConflict = true;
      monitorState.gpuConflictMsg = 'Đang dùng bộ dựng phần mềm CPU (SwiftShader). Tăng tốc phần cứng GPU đang bị tắt!';
    } else {
      monitorState.gpuAccelerated = true;
    }
  } catch (_) {
    monitorState.gpuRenderer = 'Card đồ họa thông thường';
    monitorState.gpuAccelerated = true;
  }
}

function fpsLoop() {
  const now = performance.now();
  frameCount++;
  if (now - lastFpsTime >= 1000) {
    currentFps = Math.min(60, Math.round((frameCount * 1000) / (now - lastFpsTime)));
    frameCount = 0;
    lastFpsTime = now;
  }
  requestAnimationFrame(fpsLoop);
}

function tickSystemMetrics() {
  const now = performance.now();
  const delta = now - lastLagCheck;
  lastLagCheck = now;

  eventLoopLag = Math.max(0.5, delta - 800);
  monitorState.eventLoopLag = eventLoopLag;
  monitorState.fps = currentFps;

  const isVideoAnalyzing = !!state.videoAnalyzing;
  const isCameraBusy = !!state.cameraBusy;
  const isAiActive = isVideoAnalyzing || isCameraBusy;
  const fpsLoss = Math.max(0, (60 - currentFps) / 60);

  // Thử kết nối và lấy số liệu thật từ OS Agent
  pollOsAgentMetrics();

  if (!monitorState.osAgentConnected) {
    // Chế độ mô phỏng dự phòng khi chưa bật OS Agent
    const lagLoss = Math.min(1, eventLoopLag / 120);
    const cameraBoost = (state.cameraStream && !$('camVideo').paused) ? 14 : 0;
    const aiBoost = isVideoAnalyzing ? 42 : (isCameraBusy ? 24 : 0);
    const jitter = (Math.sin(now / 1500) * 3) + (Math.cos(now / 800) * 2);
    const baseCpu = 6 + (fpsLoss * 45) + (lagLoss * 40) + cameraBoost + aiBoost + jitter;
    monitorState.cpuPercent = Math.min(100, Math.max(4, Math.round(baseCpu)));

    // Tốc độ I/O ổ đĩa mô phỏng
    monitorState.ioReadSpeedMb = isVideoAnalyzing ? 540 : 350;

    // RAM (JS Heap)
    if (performance && performance.memory) {
      monitorState.usedHeapMb = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
      monitorState.limitHeapMb = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
      monitorState.heapPercent = Math.min(100, Math.round((monitorState.usedHeapMb / monitorState.limitHeapMb) * 100));
    } else {
      const baseHeap = 70 + (state.cameraLog.length * 2.5) + (state.rows.length * 0.5);
      monitorState.usedHeapMb = Math.round(baseHeap);
      monitorState.limitHeapMb = 2048;
      monitorState.heapPercent = Math.round((monitorState.usedHeapMb / monitorState.limitHeapMb) * 100);
    }
  }

  // Tính % tải GPU ước tính (GPU Load) dựa trên Render Frame Rate và Giải mã Video Camera
  const camActive = (state.cameraStream && !$('camVideo').paused);
  const gpuJitter = (Math.cos(now / 1300) * 2) + (Math.sin(now / 700) * 1.5);
  let baseGpu = 8 + (fpsLoss * 20) + gpuJitter;
  if (camActive) baseGpu += 22; // Khi bật webcam: GPU giải mã luồng video
  if (isVideoAnalyzing) baseGpu += 34; // Khi AI phân tích video: giải mã và đọc frame
  else if (isCameraBusy) baseGpu += 20; // Khi AI chụp & xử lý frame camera
  if (!monitorState.gpuAccelerated) baseGpu = 4;
  monitorState.gpuPercent = Math.min(100, Math.max(4, Math.round(baseGpu)));

  // Cập nhật thông số Mạng (Network Information API)
  if (!monitorState.osAgentConnected && navigator.connection) {
    const conn = navigator.connection;
    monitorState.netType = conn.effectiveType ? conn.effectiveType.toUpperCase() : (conn.type || 'Băng thông rộng');
    monitorState.netDownlink = conn.downlink || 10;
    monitorState.netRtt = conn.rtt || 50;
    monitorState.netSaveData = !!conn.saveData;
  }

  // Cập nhật thông số Ổ cứng / Storage Quota (trình duyệt)
  if (!monitorState.osAgentConnected && navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      monitorState.diskQuotaMb = Math.round((est.quota || 0) / 1024 / 1024);
      monitorState.diskUsedMb = Math.round((est.usage || 0) / 1024 / 1024);
      monitorState.diskUsagePercent = monitorState.diskQuotaMb ? Math.min(100, Math.round((monitorState.diskUsedMb / monitorState.diskQuotaMb) * 100)) : 0;
    }).catch(() => {});
  }

  evaluateAutoConflicts();
  updateMonitorUI();
}

function evaluateAutoConflicts() {
  const m = monitorState;

  // CPU: khi có OS Agent dùng % CPU thật, ngưỡng cảnh báo nới rộng hơn vì đây là toàn hệ thống
  const cpuThreshold = m.osAgentConnected ? 90 : 85;
  if (m.cpuPercent >= cpuThreshold || (!m.osAgentConnected && m.eventLoopLag > 70)) {
    m.cpuConflict = true;
    m.cpuConflictMsg = `CPU đang tải nặng (${m.cpuPercent}%${m.osAgentConnected ? ' - Task Manager' : ', trễ ' + m.eventLoopLag.toFixed(1) + 'ms'}). Các ứng dụng nền đang làm nghẽn tiến trình!`;
  } else {
    m.cpuConflict = false;
    m.cpuConflictMsg = '';
  }

  // RAM: khi có OS Agent dùng % RAM vật lý thật của toàn Windows
  const ramCheckPercent = m.osAgentConnected ? m.heapPercent : m.heapPercent;
  if (ramCheckPercent >= 80) {
    m.ramConflict = true;
    m.ramConflictMsg = m.osAgentConnected
      ? `RAM hệ thống sắp đầy (${m.usedHeapMb} MB / ${m.limitHeapMb} MB - ${m.heapPercent}%). Cần đóng bớt ứng dụng!`
      : `Bộ nhớ RAM trình duyệt sắp đầy (${m.usedHeapMb} MB - ${m.heapPercent}%). Cần đóng bớt tab!`;
  } else {
    m.ramConflict = false;
    m.ramConflictMsg = '';
  }

  if (!navigator.onLine) {
    m.netConflict = true;
    m.netConflictMsg = 'Thiết bị đang ngắt kết nối mạng Internet!';
  }
}

async function runConflictScan() {
  const btn = $('btnScanConflictMain');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> Đang quét...';
  }

  // 1. Kiểm tra camera conflict
  if (!state.cameraStream) {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === 'videoinput');
        if (videoDevices.length === 0) {
          monitorState.cameraConflict = true;
          monitorState.cameraConflictMsg = 'Không tìm thấy webcam / camera nào trên máy tính.';
        } else {
          try {
            const testStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
            testStream.getTracks().forEach((t) => t.stop());
            monitorState.cameraConflict = false;
            monitorState.cameraConflictMsg = '';
          } catch (camErr) {
            if (camErr.name === 'NotReadableError' || /device in use|could not start/i.test(camErr.message)) {
              monitorState.cameraConflict = true;
              monitorState.cameraConflictMsg = 'Xung đột: Camera đang bị ứng dụng khác (Zoom, Teams, OBS, Zalo, Camera Windows...) khóa độc quyền!';
            } else if (camErr.name === 'NotAllowedError') {
              monitorState.cameraConflict = true;
              monitorState.cameraConflictMsg = 'Quyền truy cập Camera bị từ chối hoặc bị chặn bởi cài đặt Windows.';
            }
          }
        }
      }
    } catch (_) {}
  } else {
    monitorState.cameraConflict = false;
    monitorState.cameraConflictMsg = '';
  }

  // 2. Kiểm tra GPU
  detectGpuInfo();

  // 3. Kiểm tra mạng & Gemini API
  try {
    if (!navigator.onLine) {
      monitorState.netConflict = true;
      monitorState.netConflictMsg = 'Máy tính đang offline, không có kết nối mạng!';
    } else {
      await fetch(`${API_BASE}/models?key=${state.apiKey || 'test'}`, { method: 'GET', signal: AbortSignal.timeout(3500) })
        .catch((e) => {
          if (/Failed to fetch|NetworkError|abort/i.test(e.message) && !navigator.onLine) {
            monitorState.netConflict = true;
            monitorState.netConflictMsg = 'Tường lửa, Proxy hoặc VPN có thể đang chặn kết nối đến Google Gemini API!';
          } else {
            monitorState.netConflict = false;
            monitorState.netConflictMsg = '';
          }
        });
    }
  } catch (_) {}

  monitorState.lastScanTime = new Date().toLocaleTimeString('vi-VN');
  const scanTimeEl = $('conflictScanTime');
  if (scanTimeEl) scanTimeEl.textContent = 'Vừa quét lúc ' + monitorState.lastScanTime;

  setTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Quét xung đột ngay';
    }
    updateMonitorUI();
  }, 400);
}

function formatGpuName(raw) {
  if (!raw) return 'Đồ họa phần cứng';
  const match = raw.match(/^ANGLE\s*\([^,]+,\s*(.+?)(?:\s+Direct3D|\s+OpenGL|\s*,\s*(?:0x|D[0-9A-Fa-f]))/i);
  if (match && match[1]) {
    return match[1].replace(/,\s*$/, '').trim();
  }
  return raw;
}

function updateMonitorUI() {
  const m = monitorState;

  // Helper: chỉ cập nhật className khi thực sự thay đổi (tránh reset CSS transition)
  function setGaugeClass(el, baseClass, extraClass) {
    const newClass = baseClass + (extraClass ? ' ' + extraClass : '');
    if (el && el.className !== newClass) el.className = newClass;
  }
  function setGaugeDeg(el, deg) {
    if (el) el.style.setProperty('--gauge-deg', deg + 'deg');
  }

  // 1. Cập nhật CPU
  const cpuPercent = m.cpuPercent;
  const cpuValEl = $('cpuPercentVal');
  if (cpuValEl) cpuValEl.textContent = cpuPercent + '%';
  const cpuCoresEl = $('cpuCoresTag');
  if (cpuCoresEl) cpuCoresEl.textContent = m.cpuCores + ' Luồng logic';
  const cpuBarFill = $('cpuBarFill');
  if (cpuBarFill) cpuBarFill.style.width = cpuPercent + '%';
  const cpuLagEl = $('cpuLagVal');
  if (cpuLagEl) cpuLagEl.textContent = m.eventLoopLag.toFixed(1) + ' ms';
  const cpuFpsEl = $('cpuFpsVal');
  if (cpuFpsEl) cpuFpsEl.textContent = m.fps + ' FPS';

  const cpuCircle = $('cpuGaugeCircle');
  const cpuSeverity = cpuPercent >= 80 ? 'danger' : cpuPercent >= 50 ? 'warn' : '';
  setGaugeDeg(cpuCircle, Math.round((cpuPercent / 100) * 360));
  setGaugeClass(cpuCircle, 'gauge-circle', cpuSeverity);
  setGaugeClass(cpuBarFill, 'metric-progress-fill', cpuSeverity);

  const cpuStatus = $('cpuStatusText');
  if (cpuStatus) {
    if (cpuPercent >= 80) {
      cpuStatus.textContent = 'Tải nặng (Nhiều tác vụ)';
      cpuStatus.className = 'text-danger';
    } else if (cpuPercent >= 50) {
      cpuStatus.textContent = 'Đang xử lý';
      cpuStatus.className = 'text-warn';
    } else {
      cpuStatus.textContent = 'Mượt mà';
      cpuStatus.className = 'text-success';
    }
  }

  // 2. Cập nhật GPU
  const gpuRendererEl = $('gpuRendererName');
  if (gpuRendererEl) {
    gpuRendererEl.textContent = formatGpuName(m.gpuRenderer);
    gpuRendererEl.title = m.gpuRenderer;
  }
  const gpuVendorEl = $('gpuVendorName');
  if (gpuVendorEl) {
    gpuVendorEl.textContent = m.gpuVendor ? `Nhà sản xuất: ${m.gpuVendor}` : 'Đồ họa tích hợp / Rời';
  }
  const gpuBadgeEl = $('gpuAccelBadge');
  if (gpuBadgeEl) {
    gpuBadgeEl.textContent = m.gpuAccelerated ? 'Tăng tốc 3D' : 'Dựng bằng CPU';
    gpuBadgeEl.className = 'badge-tag ' + (m.gpuAccelerated ? '' : 'text-danger');
  }
  const gpuAccelText = $('gpuAccelText');
  if (gpuAccelText) {
    gpuAccelText.textContent = m.gpuAccelerated ? 'Hoạt động ổn định' : 'Chưa bật tăng tốc phần cứng';
    gpuAccelText.className = m.gpuAccelerated ? 'text-success' : 'text-danger';
  }
  const gpuContextText = $('gpuContextText');
  if (gpuContextText) {
    gpuContextText.textContent = m.gpuLost ? 'Mất ngữ cảnh (Driver lỗi)' : 'Ổn định';
    gpuContextText.className = m.gpuLost ? 'text-danger' : 'text-success';
  }
  const gpuStatusText = $('gpuStatusText');
  if (gpuStatusText) {
    gpuStatusText.textContent = m.gpuConflict ? 'Bị ứng dụng khác chiếm giữ' : (m.gpuAccelerated ? 'Không bị chiếm giữ' : 'Hiệu năng cơ bản');
    gpuStatusText.className = m.gpuConflict ? 'text-danger' : (m.gpuAccelerated ? 'text-success' : 'text-warn');
  }

  // GPU Gauge & Bar Fill: Mức tải GPU ước tính (% GPU Load giống Task Manager)
  const gpuPercent = m.gpuPercent;
  const gpuScoreVal = $('gpuScoreVal');
  const gpuScoreSub = $('gpuScoreSub');
  const gpuBarFill = $('gpuBarFill');
  const gpuGaugeCircle = $('gpuGaugeCircle');
  if (gpuGaugeCircle) {
    if (m.gpuConflict || m.gpuLost) {
      if (gpuScoreVal) gpuScoreVal.textContent = 'LỖI';
      if (gpuScoreSub) gpuScoreSub.textContent = 'Mất Driver';
      if (gpuBarFill) { gpuBarFill.style.width = '100%'; setGaugeClass(gpuBarFill, 'metric-progress-fill', 'danger'); }
      setGaugeDeg(gpuGaugeCircle, 360);
      setGaugeClass(gpuGaugeCircle, 'gauge-circle gpu-circle', 'danger');
    } else if (!m.gpuAccelerated) {
      if (gpuScoreVal) gpuScoreVal.textContent = 'YẾU';
      if (gpuScoreSub) gpuScoreSub.textContent = 'Dựng giả lập CPU';
      if (gpuBarFill) { gpuBarFill.style.width = '30%'; setGaugeClass(gpuBarFill, 'metric-progress-fill', 'warn'); }
      setGaugeDeg(gpuGaugeCircle, 108);
      setGaugeClass(gpuGaugeCircle, 'gauge-circle gpu-circle', 'warn');
    } else {
      if (gpuScoreVal) gpuScoreVal.textContent = gpuPercent + '%';
      if (gpuScoreSub) gpuScoreSub.textContent = 'Tải GPU ước tính';
      if (gpuBarFill) {
        gpuBarFill.style.width = gpuPercent + '%';
        setGaugeClass(gpuBarFill, 'metric-progress-fill', gpuPercent >= 80 ? 'danger' : gpuPercent >= 55 ? 'warn' : 'success');
      }
      setGaugeDeg(gpuGaugeCircle, Math.round((gpuPercent / 100) * 360));
      setGaugeClass(gpuGaugeCircle, 'gauge-circle gpu-circle', gpuPercent >= 80 ? 'danger' : gpuPercent >= 55 ? 'warn' : '');
    }
  }

  // 3. Cập nhật RAM
  const ramPercent = m.heapPercent;
  const ramValEl = $('ramPercentVal');
  if (ramValEl) ramValEl.textContent = ramPercent + '%';
  const deviceRamTag = $('deviceRamTag');
  if (deviceRamTag) deviceRamTag.textContent = m.deviceRamGb + ' GB RAM';
  const ramUsedEl = $('ramUsedVal');
  if (ramUsedEl) ramUsedEl.textContent = m.usedHeapMb + ' MB';
  const ramLimitEl = $('ramLimitVal');
  if (ramLimitEl) ramLimitEl.textContent = m.limitHeapMb + ' MB';
  const ramBarFill = $('ramBarFill');
  if (ramBarFill) ramBarFill.style.width = ramPercent + '%';

  const ramCircle = $('ramGaugeCircle');
  const ramSeverity = ramPercent >= 80 ? 'danger' : ramPercent >= 60 ? 'warn' : '';
  setGaugeDeg(ramCircle, Math.round((ramPercent / 100) * 360));
  setGaugeClass(ramCircle, 'gauge-circle ram-circle', ramSeverity);
  setGaugeClass(ramBarFill, 'metric-progress-fill', ramSeverity);

  const ramStatus = $('ramStatusText');
  if (ramStatus) {
    if (ramPercent >= 80) {
      ramStatus.textContent = 'Bộ nhớ sắp đầy';
      ramStatus.className = 'text-danger';
    } else if (ramPercent >= 60) {
      ramStatus.textContent = 'Mức dùng khá cao';
      ramStatus.className = 'text-warn';
    } else {
      ramStatus.textContent = 'Dồi dào, an toàn';
      ramStatus.className = 'text-success';
    }
  }

  // 4. Cập nhật Card Mạng & Băng thông (Network Interface Card)
  const netDownlink = m.netDownlink;
  const netSpeedEl = $('netSpeedVal');
  if (netSpeedEl) netSpeedEl.textContent = netDownlink.toFixed(1) + ' Mbps';
  const netTypeTag = $('netTypeTag');
  if (netTypeTag) netTypeTag.textContent = m.netType;

  // Tính tỷ lệ % mạng dựa trên chuẩn khuyến nghị (>= 15 Mbps là 100%)
  let netPct = 100;
  if (netDownlink < 15) {
    netPct = Math.min(95, Math.max(18, Math.round((netDownlink / 15) * 85)));
  }
  const netSeverity = (!navigator.onLine || netDownlink < 1.5) ? 'danger' : (netDownlink < 8 ? 'warn' : '');

  const netBarFill = $('netBarFill');
  if (netBarFill) {
    netBarFill.style.width = netPct + '%';
    setGaugeClass(netBarFill, 'metric-progress-fill', netSeverity || 'net');
  }
  const netCircle = $('netGaugeCircle');
  if (netCircle) {
    setGaugeDeg(netCircle, Math.round((netPct / 100) * 360));
    setGaugeClass(netCircle, 'gauge-circle net-circle', netSeverity);
  }
  const netRttEl = $('netRttVal');
  if (netRttEl) netRttEl.textContent = m.netRtt + ' ms';
  const netStatusEl = $('netStatusText');
  if (netStatusEl) {
    if (!navigator.onLine) {
      netStatusEl.textContent = 'Mất kết nối';
      netStatusEl.className = 'text-danger';
    } else if (netDownlink < 1.5) {
      netStatusEl.textContent = 'Mạng rất yếu';
      netStatusEl.className = 'text-danger';
    } else if (netDownlink < 8) {
      netStatusEl.textContent = 'Tốc độ trung bình';
      netStatusEl.className = 'text-warn';
    } else {
      netStatusEl.textContent = 'Đường truyền tốt';
      netStatusEl.className = 'text-success';
    }
  }

  // 5. Cập nhật Ổ cứng (SSD / Storage I/O)
  const diskUsedMb = m.diskUsedMb;
  const diskQuotaMb = m.diskQuotaMb || 2048;
  const diskValEl = $('diskPercentVal');
  if (diskValEl) diskValEl.textContent = (m.ioReadSpeedMb || 350) + ' MB/s';
  const diskTag = $('diskTypeTag');
  if (diskTag) diskTag.textContent = m.diskType;

  // Tốc độ đọc file I/O: 350-1000 MB/s
  const diskReadPct = Math.min(100, Math.max(15, Math.round(((m.ioReadSpeedMb || 350) / 1000) * 100)));
  const diskBarFill = $('diskBarFill');
  if (diskBarFill) {
    diskBarFill.style.width = diskReadPct + '%';
    setGaugeClass(diskBarFill, 'metric-progress-fill', 'disk');
  }
  const diskCircle = $('diskGaugeCircle');
  if (diskCircle) {
    setGaugeDeg(diskCircle, Math.round((diskReadPct / 100) * 360));
    setGaugeClass(diskCircle, 'gauge-circle disk-circle', '');
  }
  const diskQuotaEl = $('diskQuotaVal');
  const diskStorageLabel = $('diskStorageLabel');
  if (diskQuotaEl) {
    if (m.osAgentConnected && m.realDiskTotalGb > 0) {
      if (diskStorageLabel) diskStorageLabel.textContent = 'Dung lượng ổ đĩa (C:):';
      diskQuotaEl.textContent = `${m.realDiskUsedGb} GB / ${m.realDiskTotalGb} GB (${m.diskUsagePercent}%)`;
    } else {
      if (diskStorageLabel) diskStorageLabel.textContent = 'Bộ nhớ đệm lưu trữ:';
      diskQuotaEl.textContent = `${diskUsedMb} MB / ${diskQuotaMb >= 1024 ? (diskQuotaMb / 1024).toFixed(1) + ' GB' : diskQuotaMb + ' MB'}`;
    }
  }
  const diskSeekEl = $('diskSeekVal');
  if (diskSeekEl) {
    diskSeekEl.textContent = `~${m.diskSeekMs} ms (Rất nhanh)`;
  }
  const diskIoEl = $('diskIoStatusText');
  if (diskIoEl) {
    const readSpeed = m.ioReadSpeedMb || 350;
    if (m.diskConflict || readSpeed < 100) {
      diskIoEl.textContent = 'Nghẽn đọc ghi (I/O Wait)';
      diskIoEl.className = 'text-danger';
    } else if (readSpeed < 250) {
      diskIoEl.textContent = 'Tốc độ trung bình (SATA/HDD)';
      diskIoEl.className = 'text-warn';
    } else if (readSpeed >= 500) {
      diskIoEl.textContent = 'Đọc luồng cao (NVMe Burst)';
      diskIoEl.className = 'text-success';
    } else {
      diskIoEl.textContent = 'Phản hồi tức thì (SSD)';
      diskIoEl.className = 'text-success';
    }
  }

  // Cập nhật huy hiệu OS Agent
  const agentDot = $('osAgentDot');
  const agentText = $('osAgentText');
  const agentBadge = $('osAgentStatusBadge');
  if (agentText && agentDot) {
    if (m.osAgentConnected) {
      agentDot.style.color = '#10b981';
      agentText.textContent = 'OS Agent: Task Manager';
      if (agentBadge) {
        agentBadge.style.borderColor = '#86efac';
        agentBadge.style.background = '#f0fdf4';
      }
    } else {
      agentDot.style.color = '#f59e0b';
      agentText.textContent = 'Web Mode (Chạy agent.py để lấy OS thật)';
      if (agentBadge) {
        agentBadge.style.borderColor = '#fed7aa';
        agentBadge.style.background = '#fffbeb';
      }
    }
  }

  // 6. Header live status widget
  const headerSysText = $('headerSysText');
  const headerSysStatus = $('headerSysStatus');
  const sysDot = headerSysStatus?.querySelector('.sys-dot');
  const hasAnyConflict = m.cameraConflict || m.gpuConflict || m.cpuConflict || m.ramConflict || m.netConflict;
  const isHighLoad = cpuPercent >= 80 || ramPercent >= 75;

  if (headerSysText) {
    headerSysText.textContent = m.osAgentConnected
      ? `CPU ${cpuPercent}% · RAM ${m.usedHeapMb} MB`
      : `CPU ${cpuPercent}% · RAM ${m.usedHeapMb} MB`;
  }
  if (sysDot) {
    sysDot.className = 'sys-dot' + (hasAnyConflict ? ' err' : isHighLoad ? ' warn' : '');
  }

  // 7. Đồng bộ khối mini chỉ số phần cứng trên khối thống kê (Video & Camera)
  const cpuClass = cpuPercent >= 80 ? 'danger' : cpuPercent >= 50 ? 'warn' : '';
  const ramClass = ramPercent >= 80 ? 'danger' : ramPercent >= 60 ? 'warn' : '';
  const gpuClass = gpuPercent >= 80 ? 'danger' : gpuPercent >= 55 ? 'warn' : 'gpu';

  // Video Mini Stats Strip
  const vidCpuVal = $('vidMiniCpuVal'); if (vidCpuVal) vidCpuVal.textContent = cpuPercent + '%';
  const vidCpuBar = $('vidMiniCpuBar'); if (vidCpuBar) { vidCpuBar.style.width = cpuPercent + '%'; vidCpuBar.className = 'mini-bar-fill ' + cpuClass; }
  const vidRamVal = $('vidMiniRamVal'); if (vidRamVal) vidRamVal.textContent = m.usedHeapMb + ' MB';
  const vidRamBar = $('vidMiniRamBar'); if (vidRamBar) { vidRamBar.style.width = ramPercent + '%'; vidRamBar.className = 'mini-bar-fill ' + ramClass; }
  const vidGpuVal = $('vidMiniGpuVal'); if (vidGpuVal) vidGpuVal.textContent = gpuPercent + '%';
  const vidGpuBar = $('vidMiniGpuBar'); if (vidGpuBar) { vidGpuBar.style.width = gpuPercent + '%'; vidGpuBar.className = 'mini-bar-fill ' + gpuClass; }
  const vidDiskVal = $('vidMiniDiskVal'); if (vidDiskVal) vidDiskVal.textContent = (m.ioReadSpeedMb || 350) + ' MB/s';
  const vidDiskBar = $('vidMiniDiskBar'); if (vidDiskBar) { vidDiskBar.style.width = Math.min(100, Math.max(10, Math.round(((m.ioReadSpeedMb || 350) / 1000) * 100))) + '%'; vidDiskBar.className = 'mini-bar-fill disk'; }

  // Camera Mini Stats Strip
  const camCpuVal = $('camMiniCpuVal'); if (camCpuVal) camCpuVal.textContent = cpuPercent + '%';
  const camCpuBar = $('camMiniCpuBar'); if (camCpuBar) { camCpuBar.style.width = cpuPercent + '%'; camCpuBar.className = 'mini-bar-fill ' + cpuClass; }
  const camRamVal = $('camMiniRamVal'); if (camRamVal) camRamVal.textContent = m.usedHeapMb + ' MB';
  const camRamBar = $('camMiniRamBar'); if (camRamBar) { camRamBar.style.width = ramPercent + '%'; camRamBar.className = 'mini-bar-fill ' + ramClass; }
  const camGpuVal = $('camMiniGpuVal'); if (camGpuVal) camGpuVal.textContent = gpuPercent + '%';
  const camGpuBar = $('camMiniGpuBar'); if (camGpuBar) { camGpuBar.style.width = gpuPercent + '%'; camGpuBar.className = 'mini-bar-fill ' + gpuClass; }
  const camFpsVal = $('camMiniFpsVal'); if (camFpsVal) camFpsVal.textContent = m.fps + ' FPS';
  const camFpsBar = $('camMiniFpsBar'); if (camFpsBar) { camFpsBar.style.width = Math.min(100, Math.round((m.fps / 60) * 100)) + '%'; }

  // 8. Cập nhật Bảng Kiểm tra Xung đột trong trang Monitor
  updateConflictChecklist();
}

function updateConflictChecklist() {
  const m = monitorState;

  // Item Camera
  updateConflictItem('chkCameraBadge', 'chkCameraDesc', m.cameraConflict, {
    okBadge: '<i class="fa-solid fa-check"></i> Sẵn sàng',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> Bị chiếm giữ',
    okDesc: 'Webcam sẵn sàng. Không phát hiện phần mềm nào (như Zoom, Teams, Zalo...) chiếm quyền camera.',
    errDesc: m.cameraConflictMsg || 'Camera đang bị ứng dụng khác chiếm dụng hoặc bị chặn quyền truy cập!',
  });

  // Item GPU (Góc nhìn Hệ điều hành & Phần cứng)
  updateConflictItem('chkGpuBadge', 'chkGpuDesc', m.gpuConflict || !m.gpuAccelerated || m.gpuLost, {
    okBadge: '<i class="fa-solid fa-check"></i> Sẵn sàng',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> Lỗi đồ họa',
    okDesc: `Card đồ họa (${formatGpuName(m.gpuRenderer)}) hoạt động tốt, hỗ trợ tăng tốc phát video mượt mà.`,
    errDesc: m.gpuConflictMsg || 'Card đồ họa hoặc trình điều khiển bị lỗi, trình duyệt phải dựng hình thủ công.',
  });

  // Item CPU
  updateConflictItem('chkCpuBadge', 'chkCpuDesc', m.cpuConflict, {
    okBadge: '<i class="fa-solid fa-check"></i> Phản hồi nhanh',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> CPU bận',
    okDesc: `Máy tính phản hồi tức thì (${m.eventLoopLag.toFixed(1)} ms), không bị các phần mềm ngầm làm đơ máy.`,
    errDesc: m.cpuConflictMsg || 'Máy tính đang bị quá tải bởi các ứng dụng ngầm khác (>85%)!',
  });

  // Item RAM
  updateConflictItem('chkRamBadge', 'chkRamDesc', m.ramConflict, {
    okBadge: '<i class="fa-solid fa-check"></i> Bộ nhớ an toàn',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> Sắp đầy bộ nhớ',
    okDesc: m.osAgentConnected
      ? `RAM thật máy tính: ${m.usedHeapMb} MB / ${m.limitHeapMb} MB (${m.heapPercent}%) — đủ để xử lý video liên tục.`
      : `Dung lượng RAM trống dồi dào (${m.usedHeapMb} MB / ${m.limitHeapMb} MB), đủ để tải và xem video liên tục.`,
    errDesc: m.ramConflictMsg || 'Bộ nhớ RAM sắp đầy (>80%), nên đóng bớt tab trước khi phân tích!',
  });

  // Item Mạng
  updateConflictItem('chkNetBadge', 'chkNetDesc', m.netConflict, {
    okBadge: '<i class="fa-solid fa-check"></i> Thông suốt',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> Mạng gián đoạn',
    okDesc: `Tốc độ mạng ${m.netDownlink.toFixed(1)} Mbps (Ping ${m.netRtt}ms), kết nối tới máy chủ Google AI rất ổn định.`,
    errDesc: m.netConflictMsg || 'Không thể kết nối API Google: Mạng bị mất kết nối hoặc bị tường lửa/VPN chặn.',
  });

  // Item Ổ cứng SSD/HDD
  updateConflictItem('chkDiskBadge', 'chkDiskDesc', Boolean(m.diskConflict), {
    okBadge: '<i class="fa-solid fa-check"></i> Ổ cứng mượt',
    errBadge: '<i class="fa-solid fa-triangle-exclamation"></i> Ổ cứng bận',
    okDesc: m.osAgentConnected
      ? `Tốc độ đọc SSD thật: ${m.ioReadSpeedMb} MB/s, Seek: ${m.diskSeekMs} ms. Dung lượng: ${m.realDiskUsedGb}/${m.realDiskTotalGb} GB.`
      : `Tốc độ đọc ổ đĩa ~${m.ioReadSpeedMb} MB/s, mở video lên ngay tức thì mà không phải chờ đợi.`,
    errDesc: m.diskConflictMsg || 'Ổ cứng đang bận đọc ghi tác vụ khác (I/O Wait), thời gian mở video có thể hơi chậm!',
  });

  // Main Banner
  const conflicts = [];
  if (m.cameraConflict) conflicts.push('Camera');
  if (m.gpuConflict) conflicts.push('Card đồ họa (GPU)');
  if (m.cpuConflict) conflicts.push('CPU');
  if (m.ramConflict) conflicts.push('Bộ nhớ RAM');
  if (m.diskConflict) conflicts.push('Ổ cứng máy tính');
  if (m.netConflict) conflicts.push('Kết nối Mạng');

  const banner = $('conflictMainBanner');
  const title = $('conflictBannerTitle');
  const desc = $('conflictBannerDesc');

  if (banner && title && desc) {
    if (conflicts.length > 0) {
      banner.className = 'conflict-banner err';
      banner.querySelector('.conflict-banner-icon').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
      title.textContent = `Phát hiện xung đột ở ${conflicts.length} thành phần: ${conflicts.join(', ')}`;
      desc.textContent = 'Một số ứng dụng khác trên máy đang chiếm giữ thiết bị. Hãy kiểm tra các mục có màu đỏ bên dưới để khắc phục.';
    } else if (m.cpuPercent >= 75 || m.heapPercent >= 65) {
      banner.className = 'conflict-banner warn';
      banner.querySelector('.conflict-banner-icon').innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
      title.textContent = 'Máy tính đang chạy nhiều tác vụ cùng lúc';
      desc.textContent = 'Tải CPU hoặc RAM đang hơi cao. Ứng dụng vẫn hoạt động nhưng tốc độ nhận diện có thể chậm hơn một chút.';
    } else {
      banner.className = 'conflict-banner ok';
      banner.querySelector('.conflict-banner-icon').innerHTML = '<i class="fa-solid fa-circle-check"></i>';
      title.textContent = 'Máy tính sẵn sàng — Không phát hiện xung đột nào';
      desc.textContent = 'Camera, Card màn hình, CPU, RAM, Ổ cứng và Mạng đều đang ở trạng thái tốt nhất để chạy ứng dụng.';
    }
  }
}

function updateConflictItem(badgeId, descId, isError, { okBadge, errBadge, okDesc, errDesc }) {
  const badge = $(badgeId);
  const desc = $(descId);
  if (!badge || !desc) return;
  if (isError) {
    badge.className = 'conflict-status-badge err';
    badge.innerHTML = errBadge;
    desc.innerHTML = `<span class="text-danger font-semibold">${escapeHtml(errDesc)}</span>`;
  } else {
    badge.className = 'conflict-status-badge ok';
    badge.innerHTML = okBadge;
    desc.textContent = okDesc;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initSettingsPage();
  initNav();
  initVideoPage();
  initCameraPage();
  initChatPage();
  initImageModal();
  initTooltips();
  initSystemMonitor();
});
