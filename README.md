# AI Sitemap Analyzer (OpenAI + Vercel)

Tool phân tích sitemap theo mô hình hybrid:
- Rule-based xử lý toàn bộ URL đã thu thập.
- OpenAI xử lý lớp suy luận trên mẫu URL đại diện để tối ưu token.

## Website có sitemap rất nhiều URL thì làm thế nào?

Đã nâng cấp theo hướng **scalable**:
1. Hỗ trợ `sitemapindex` (crawl nhiều file sitemap con, không chỉ 1 file).
2. Giới hạn crawl an toàn: tối đa `maxSitemaps=40`, `maxUrls=50000` (tránh timeout Vercel).
3. Sampling **thích ứng theo quy mô** thay vì cố định 60 URL:
   - `quick`: khoảng 30–60 mẫu
   - `balanced`: khoảng 50–120 mẫu
   - `deep`: khoảng 80–220 mẫu
4. Sampling theo tỷ trọng bucket thư mục để vẫn đại diện khi website rất lớn.

> Với site cực lớn (vài trăm nghìn URL), nên chạy theo từng sitemap con theo lịch (cron/batch), lưu kết quả DB rồi tổng hợp dashboard.

### Lưu ý sử dụng
- Nếu bấm phân tích khi chưa nhập API key/model, hệ thống sẽ báo lỗi: **Vui lòng nhập API key/model**.
- Hệ thống hiển thị progress bar `AI thinking...` kèm phần trăm tăng dần cho đến khi hoàn tất.

### Khuyến nghị triển khai public
Vì API key nhập từ trình duyệt và gửi vào backend của tool, nên:
1. Chỉ dùng key cá nhân hoặc key đã giới hạn quyền/credit.
2. Bật rate limit phía backend nếu mở public.
3. Nên thêm cảnh báo bảo mật trong UI trước khi người dùng nhập key.


## Chính sách phiên ngắn hạn và bảo mật key
- Không dùng API key/model từ biến môi trường cho luồng community.
- Chỉ dùng key/model/base URL người dùng nhập trong request hiện tại.
- Không lưu API key, không ghi log kết quả phân tích của người dùng.
- Không dùng cache kết quả liên phiên; đóng tab/mở lại sẽ cần nhập lại key và quét lại từ đầu.
- Nếu provider/api key/model/base URL không hợp lệ, API trả lỗi ngay và dừng phân tích.
