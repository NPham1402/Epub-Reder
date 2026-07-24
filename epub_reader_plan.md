# Kế hoạch triển khai ePub Reader với giao diện "Tài liệu Code" trên Worker Cloudflare D1 & R2

Mục tiêu là tạo ra một trình đọc ePub trên web với phong cách trực quan bắt chước một tài liệu mã nguồn (font chữ monospace, đánh số dòng, làm nổi bật cú pháp, giao diện "trình soạn thảo mã" nền tối).
Nó phải chạy trên nền tảng **Worker Cloudflare** hiện tại (sử dụng D1 và R2) bằng cách dùng background workers cho việc phân tích cú pháp nặng, giữ cho giao diện người dùng nhẹ và phản hồi nhanh.

## Yêu cầu người dùng xem xét
> [!IMPORTANT]
> **Chi tiết về Worker Cloudflare** – Vui lòng xác nhận chính xác môi trường chạy của các worker D1/R2 (ví dụ: chúng là Cloudflare Workers thực thụ, dịch vụ Node.js tùy chỉnh, hay Docker containers?).
> Kế hoạch này giả định sử dụng mô hình web worker / Service Worker tiêu chuẩn; có thể cần điều chỉnh cho các API độc quyền.

> [!IMPORTANT]
> **Mục tiêu triển khai** – Bạn muốn trình đọc này được lưu trữ như một trang web tĩnh (phục vụ qua CDN) hay đóng gói bên trong một dịch vụ backend hiện có? Hãy làm rõ quy trình triển khai mà bạn mong muốn (ví dụ: CI/CD lên Cloudflare Pages, máy chủ nội bộ, v.v.).

## Các câu hỏi mở
> [!WARNING]
> - **Phạm vi tính năng** – Trình đọc có nên hỗ trợ ghi chú, tìm kiếm, hay chỉ điều hướng cơ bản (trang trước/sau, mục lục)?
> - **Nguồn ePub** – Người dùng sẽ tải lên các file ePub, lấy từ một URL công khai, hay lưu trữ trong một bucket lưu trữ cụ thể?
> - **Giới hạn hiệu năng** – Có mục tiêu thời gian tải hoặc mức sử dụng bộ nhớ tối đa nào cho các worker (D1/R2) không?

## Các thay đổi đề xuất

### 1. Cấu trúc Dự án (Vite + Vanilla JS)

- **[TẠO MỚI]** `package.json` – cấu hình Vite tối thiểu, các script và dependencies (`epubjs`, `highlight.js`)
- **[TẠO MỚI]** `vite.config.js` – bật xử lý tài nguyên tĩnh, xác định base path cho việc triển khai worker
- **[TẠO MỚI]** `index.html` – HTML gốc với `<div id="app"></div>` và các thẻ meta SEO
- **[TẠO MỚI]** `src/main.js` – mã khởi động, đăng ký Service Worker, tải các thành phần giao diện
- **[TẠO MỚI]** `src/style.css` – hệ thống thiết kế (giao diện tối, kiểu chữ dạng tài liệu code, thẻ thiết kế glass-morphism)

### 2. Các thành phần giao diện cốt lõi (Vanilla JS + CSS)

- **[TẠO MỚI]** `src/components/Reader.js` – hiển thị các trang ePub bên trong một khối `<pre><code>` đã được tạo kiểu trước, thêm số dòng, hỗ trợ cuộn.
- **[TẠO MỚI]** `src/components/Sidebar.js` – mục lục có thể thu gọn được thiết kế như một bảng phác thảo mã nguồn.
- **[TẠO MỚI]** `src/components/Toolbar.js` – các nút cho trang tiếp/trước, thu phóng, toàn màn hình; các biểu tượng sử dụng SVG tối giản để tạo cảm giác "thanh công cụ IDE".
- **[TẠO MỚI]** `src/components/StatusBar.js` – hiển thị chương hiện tại, tiến độ và tình trạng của worker (ping D1/R2).

Tất cả các thành phần sử dụng **font monospace (Fira Code)**, **làm nổi bật cú pháp** (thông qua Highlight.js) cho bất kỳ đoạn mã HTML/JS nào được trích xuất từ nội dung XHTML của ePub, làm cho tài liệu trông giống hệt mã nguồn.

### 3. Background Workers (Cloudflare D1 & R2)

- **[TẠO MỚI]** `worker/d1-parser.js` – chạy trên D1. Phân tích cú pháp ePub (sử dụng `epubjs` trong môi trường headless), trích xuất HTML sạch, loại bỏ các tài nguyên nặng và trả về một manifest JSON (cấu trúc sách, mục lục).
- **[TẠO MỚI]** `worker/r2-renderer.js` – chạy trên R2. Nhận HTML của trang, định dạng nó thành cấu trúc "giống như mã" (thêm số dòng, bọc bằng `<pre><code>`), và gửi lại cho luồng giao diện chính.
- **[TẠO MỚI]** `worker/health.js` – endpoint ping đơn giản cho thanh trạng thái giao diện, báo cáo độ trễ của D1/R2.

Ứng dụng chính đăng ký các worker này thông qua **Service Worker** (`src/service-worker.js`). Việc giao tiếp sử dụng **MessageChannel** (postMessage) để giữ cho luồng giao diện không bị chặn.

### 4. Lớp API (Tùy chọn)

Nếu nền tảng yêu cầu một API HTTP thay vì nhắn tin trực tiếp cho worker, thêm một máy chủ Express mỏng (`api/index.js`) để chuyển tiếp các yêu cầu đến các worker D1/R2. Tệp này chỉ cần thiết nếu mục tiêu triển khai không thể chứa Service Workers.

### 5. SEO & Khả năng truy cập (Accessibility)

- Thêm `<title>`: "Trình đọc ePub phong cách Code".
- Meta description: "Đọc sách ePub trong giao diện trình soạn thảo mã bóng bẩy, được hỗ trợ bởi các worker trên nền tảng Cloud."
- Sử dụng HTML ngữ nghĩa (`<nav>`, `<section>`, `<article>`).
- Đảm bảo tất cả các thành phần tương tác đều có `aria-label` và có thể điều hướng bằng bàn phím.

### 6. Quy trình Build & Deploy

- Cài đặt dependencies: `npm install`
- Server phát triển: `npm run dev` (Vite)
- Build cho production: `npm run build` (xuất ra thư mục `dist/`)
- Triển khai (ví dụ): `npm run deploy` → chạy `wrangler publish` cho Cloudflare Workers hoặc sao chép `dist/` vào CDN nội bộ của bạn.

### 7. Kế hoạch Kiểm thử (Verification Plan)

#### Kiểm thử Tự động (Automated Tests)
- **Unit tests** (`jest`) cho các parser của worker: xác minh tính chính xác của JSON manifest cho một file ePub mẫu.
- **Integration test** (Cypress) – tải ứng dụng, upload một ePub thử nghiệm, khẳng định rằng giao diện render đúng với số dòng và giao diện tối.

#### Kiểm tra Thủ công (Manual Verification)
1. Mở ứng dụng trên Chrome/Firefox; xác nhận giao diện giống với một trình soạn thảo mã (monospace, số dòng, làm nổi bật cú pháp).
2. Sử dụng Chrome DevTools → Tab Performance để đảm bảo luồng giao diện không bị chặn quá 50ms trong quá trình tải trang.
3. Kiểm tra thanh trạng thái hiển thị số liệu độ trễ thực tế cho D1/R2 (mô phỏng nghẽn mạng).
4. Xác thực các thẻ SEO bằng `view-source:` và đánh giá Lighthouse (điểm > 90).

---

**Các bước tiếp theo**
- Chờ làm rõ về môi trường Worker Cloudflare và tùy chọn triển khai.
- Sau khi được phê duyệt, tiến hành thiết lập dự án Vite và triển khai các worker.
