# Nhận diện hành vi trong video

Trang web phân tích video ngắn và camera realtime: nhận diện từng người xuất hiện, liệt kê hành vi theo thời gian, lọc theo hành vi và chatbot hỏi đáp về nội dung video.

Toàn bộ chạy trên trình duyệt bằng HTML, CSS, JavaScript thuần. Phần AI gọi Google Gemini API (gói miễn phí).

## Thông tin học phần
- Học phần: Hệ điều hành
- Khoa: Công nghệ Thông tin — Trường Đại học Sư phạm TP. Hồ Chí Minh
- Mã lớp: 2611COMP133202
- Giảng viên hướng dẫn: ThS. Nguyễn Phương Nam

## Tính năng

- Tải video lên, nhận bảng kết quả gồm người, đặc điểm nhận dạng, hành vi, tính chất hành vi (Nguy hiểm, Bất thường, An toàn, Bình thường), thời điểm và chi tiết.
- Chia thời gian dạng link bấm trực tiếp để tua video đến đúng khung thời gian tương ứng.
- Biểu đồ cột trực quan thống kê tính chất hành vi (hiển thị số lượng, tỷ lệ %, nhấp vào cột để lọc nhanh).
- Lọc kết quả theo hành vi, tính chất hành vi hoặc tìm kiếm theo trang phục, đặc điểm.
- Tooltip tương tác hiển thị thông tin chi tiết khi rê chuột vào các nút, cột, nhãn tính chất và biểu đồ.
- Xuất kết quả ra file JSON và nhập lại khi cần, để demo không phụ thuộc vào API.
- Camera realtime: chụp khung hình theo chu kỳ 2, 3 hoặc 5 giây, đính kèm hình ảnh capture trực tiếp, nhận diện người và hành vi, lưu nhật ký có thumbnail ảnh chụp (bấm để xem phóng to trong modal).
- Giám sát hệ thống & Kiểm tra xung đột:
  + Thẻ đo CPU thời gian thực (% tải ước tính, số luồng logic, độ trễ Main Thread, tốc độ khung hình FPS).
  + Thẻ đo GPU & Đồ họa (tên chip đồ họa thực tế, kiểm tra tăng tốc phần cứng Hardware Acceleration, trạng thái WebGL context).
  + Thẻ đo RAM (chiếm dụng bộ nhớ JS Heap, tổng RAM thiết bị `navigator.deviceMemory`, cảnh báo nguy cơ tràn RAM).
  + Bảng chuẩn đoán xung đột phần cứng & phần mềm nền (phát hiện xung đột Camera bị Zoom/Teams/OBS/Zalo khóa, GPU crash, nghẽn luồng CPU, chặn mạng/tường lửa Gemini API).
  + Tiện ích đo nhanh trên thanh Header và thẻ mini-monitor ngay cạnh camera realtime.
- Chatbot trả lời câu hỏi dựa trên kết quả phân tích và nhật ký camera.

## Cài đặt và chạy

1. Mở thư mục bằng VS Code, cài extension Live Server.
2. Chuột phải `index.html`, chọn Open with Live Server.
3. Vào mục Cài đặt, dán API key lấy từ https://aistudio.google.com/apikey, bấm Lưu lại.

Có thể thay Live Server bằng `python -m http.server 5500` rồi mở http://localhost:5500. Cần chạy qua localhost để trình duyệt cho phép dùng camera.

## Cấu trúc

```
index.html   giao diện, 5 mục: Phân tích video, Camera realtime, Giám sát hệ thống, Chatbot, Cài đặt
style.css    giao diện
app.js       xử lý logic, gọi API và đo lường phần cứng
logo/        logo khoa
```

Thư viện ngoài qua CDN: Font Awesome 6, Google Fonts (Be Vietnam Pro).

## Cách hoạt động

Video được đọc thành base64 và gửi thẳng lên Gemini kèm prompt yêu cầu liệt kê người và hành vi. Request có `responseSchema` nên kết quả luôn là JSON đúng cấu trúc:

```json
{
  "summary": "Tóm tắt video",
  "persons": [
    {
      "id": "P1",
      "appearance": "nam, áo đỏ, quần jean, đeo balo",
      "events": [
        {
          "start": 0,
          "end": 4,
          "action": "đi bộ",
          "nature": "Bình thường",
          "detail": "đi từ trái sang phải"
        }
      ]
    }
  ]
}
```

Camera dùng `getUserMedia`, mỗi chu kỳ vẽ khung hình lên canvas, chuyển thành JPEG và gửi lên Gemini. Nếu request trước chưa xong thì bỏ qua lượt đó.

Chatbot gửi câu hỏi kèm `systemInstruction` chứa JSON kết quả video và 20 mục nhật ký camera gần nhất, cùng lịch sử hội thoại.

API key và tên model lưu trong `localStorage`; kết quả phân tích, nhật ký và hội thoại chỉ giữ trong phiên hiện tại.

## Giới hạn

- Video tối đa 15MB.
- Gói miễn phí có hạn mức theo phút và theo ngày. Khi thấy thông báo "Vượt hạn mức miễn phí" thì đợi một lúc hoặc đổi sang model Flash-Lite.
- Model mặc định `gemini-3.8-flash`. Bấm Tải danh sách trong Cài đặt để xem các model khả dụng.
