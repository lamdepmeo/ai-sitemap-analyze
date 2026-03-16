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

## Cấu hình backend OpenAI đúng chuẩn

Dự án gọi trực tiếp **OpenAI Responses API** bằng `fetch` tại backend/serverless:
- Endpoint: `POST https://api.openai.com/v1/responses`
- Auth: `Authorization: Bearer OPENAI_API_KEY`

Biến môi trường:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (gợi ý: `gpt-4.1-mini`)

## Khắc phục lỗi deploy Vercel dừng ở `Running "vercel build"`

Nếu log dừng sớm như ảnh bạn gửi, thường do bước cài dependency/build bị lỗi nhưng UI chưa mở hết log.

Bản hiện tại đã loại bỏ dependency bên ngoài để giảm rủi ro build:
- Không cần package `openai` nữa.
- API dùng `fetch` có sẵn trong Node runtime của Vercel.

Checklist trong Vercel Project Settings:
1. **Framework Preset**: `Other`.
2. **Build Command**: để trống.
3. **Install Command**: để trống (hoặc mặc định).
4. **Environment Variables**:
   - `OPENAI_API_KEY` (Production + Preview)
   - `OPENAI_MODEL` (tuỳ chọn)
5. Redeploy bằng **Clear build cache and redeploy**.

## Chạy local

### Frontend
```bash
python3 -m http.server 4173
```

### Backend local
```bash
export OPENAI_API_KEY="your_key"
export OPENAI_MODEL="gpt-4.1-mini"
node server.js
```

Frontend tự chọn endpoint:
- local -> `http://localhost:8787/api/analyze`
- production -> `/api/analyze`

## Deploy GitHub + Vercel

1. Push code lên GitHub.
2. Import repo vào Vercel (preset: Other).
3. Thêm env vars trên Vercel: `OPENAI_API_KEY`, `OPENAI_MODEL`.
4. Deploy.

Endpoint production:
- `POST https://<your-domain>/api/analyze`

Body ví dụ:
```json
{ "sitemapUrl": "https://example.com/sitemap.xml", "mode": "balanced" }
```

## Cấu trúc chính
- `api/analyze.js`: API route cho Vercel.
- `server.js`: backend local.
- `lib/sitemap.js`: crawl sitemapindex + deterministic + adaptive sampling.
- `app.js`: UI + chọn mode phân tích.


## Nâng cấp report theo dạng dashboard chi tiết
- Phân loại danh mục theo ngữ nghĩa URL (sản phẩm, danh mục, bài viết, tag, landing, trang tĩnh...) thay vì chỉ lấy slug đầu tiên.
- Thêm phân tích template URL (`home`, `single-level`, `two-level`, `deep-3-4`, `very-deep`).
- Thêm issue breakdown (duplicate/deep/params/slug dài/uppercase/http).
- Thêm danh sách URL chi tiết: top URL quá sâu, top URL có query, top URL dài nhất.


## Multi-prompt AI pipeline (tối ưu chất lượng)

- Đã bổ sung cơ chế parse an toàn cho phản hồi Responses API và fallback nếu model không trả JSON chuẩn, tránh lỗi `"undefined" is not valid JSON`.
- Nếu model trả JSON bị cắt dở (ví dụ phần `patterns` đang dang dở), hệ thống sẽ tự repair JSON bằng prompt phụ và fallback stage-level để tránh API 500.
Backend chạy 4 lượt prompt:
1. `technical_audit`: soi lỗi technical SEO.
2. `ia_audit`: phân tích cấu trúc thông tin / template URL.
3. `content_risk_audit`: phát hiện rủi ro intent/cannibalization/tag bloat.
4. `final_synthesis`: tổng hợp thành issues + action plan ưu tiên.

Cách này giúp kết quả sát thực tế hơn một prompt đơn lẻ.

## Export report
Sau khi phân tích xong, dashboard hỗ trợ:
- Export `JSON` (full raw report)
- Export `CSV` (bảng tóm tắt để xử lý tiếp)
- Export `PDF` (in/chia sẻ report)


## Phân loại nội dung nâng cao theo metadata sitemap
Hệ thống không chỉ dựa vào slug URL mà còn kết hợp:
- nguồn sitemap con (`sitemap-product.xml`, `sitemap-post.xml`, `sitemap-category.xml`, ...),
- `changefreq`,
- `priority`,
- pattern đường dẫn.

Từ đó phân loại thành: Trang chủ, Page tĩnh, Danh mục, Tin bài, Trang sản phẩm, Sản phẩm chi tiết, Khác.

## Dashboard trực quan + bảng lỗi từng URL
- Biểu đồ danh mục nội dung.
- Biểu đồ phân bố lỗi kỹ thuật.
- Bảng chi tiết URL lỗi (URL nào mắc lỗi gì, priority/changefreq, category).


## Tùy chọn nhập URL chuyên mục để tăng độ chính xác
Trong UI, bạn có thể nhập danh sách URL chuyên mục (mỗi dòng 1 URL). Hệ thống sẽ:
1. ưu tiên coi các URL đó là `Danh mục`,
2. tự gán các URL chi tiết về chuyên mục gần nhất theo prefix URL,
3. kết hợp thêm `changefreq`, `priority`, nguồn sitemap con và AI để tinh chỉnh phân loại.

Điều này đặc biệt hữu ích cho các sitemap không tách riêng `sitemap-category.xml`.


## Lưu ý deploy
- Dự án hiện **không cần** `vercel.json` (đã loại bỏ).
- Vercel có thể tự nhận API route trong `api/` khi deploy.

## Bảo vệ tool bằng đăng nhập cơ bản (Basic Auth)
Nếu bạn muốn chặn người lạ dùng tool, cấu hình thêm biến môi trường:
- `TOOL_USERNAME`
- `TOOL_PASSWORD`

Khi 2 biến này có giá trị, API `/api/analyze` sẽ yêu cầu header `Authorization: Basic ...`.
Frontend đã có ô nhập tài khoản/mật khẩu và lưu theo session trình duyệt.

## Kiểm tra SEO Onpage (mới)
Hệ thống đã bổ sung bóc tách HTML cho một phần URL mẫu để kiểm tra:
- Internal link nội bộ có đủ mạnh hay không.
- Anchor text có bị chung chung (vd: "xem thêm", "chi tiết") hay không.
- Có thiếu media ảnh hay không.
- Ảnh có thiếu `alt` hay không.

Kết quả được hiển thị ở:
- Biểu đồ SEO Onpage.
- Danh sách tổng quan onpage.
- Bảng lỗi chi tiết theo từng URL.

## Đăng nhập bắt buộc trước khi dùng giao diện
- UI hiện tại có cơ chế **login gate**: vào trang là thấy form đăng nhập ngay.
- Chỉ khi đăng nhập đúng `TOOL_USERNAME` / `TOOL_PASSWORD` (env trên Vercel), giao diện phân tích sitemap mới được hiển thị.
- API xác thực qua endpoint `POST /api/auth/login` với Basic Auth header.

## Hover xem chi tiết lỗi onpage + gợi ý tối ưu cụ thể
- Ở bảng lỗi URL, cột **Lỗi** đã hỗ trợ hover để xem:
  - danh sách anchor text chung chung thực tế (kèm href),
  - danh sách ảnh thiếu alt (src),
  - tips tối ưu cụ thể cho URL đó.
- Hệ thống cũng xuất thêm các `internalLinkOpportunities` để gợi ý thêm liên kết nội bộ theo chuyên mục cha.

## Phân tích toàn bộ URL nhưng vẫn tối ưu chi phí token
Đã điều chỉnh pipeline theo hướng:
1. **Deterministic chạy trên toàn bộ URL** trong sitemap (bao gồm bóc tách tín hiệu onpage từ nội dung chính của trang, không ưu tiên sidebar).
2. **AI chỉ dùng để tổng hợp/ưu tiên hành động** (multi-prompt) trên dữ liệu đã nén, không gửi toàn bộ HTML của tất cả URL lên model.

=> Như vậy vẫn phân tích đủ toàn site nhưng chi phí token giữ ở mức thấp hơn nhiều so với gửi full content.

### Phương án scale cho vài trăm / vài nghìn URL
- 0-500 URL: có thể chạy 1 lần trực tiếp.
- 500-2,000 URL: nên chạy theo lô sitemap con (batch theo category/product/post sitemap) và cache kết quả.
- >2,000 URL: nên chuyển sang kiến trúc job queue:
  - API chỉ tạo job,
  - worker nền crawl + phân tích,
  - lưu kết quả DB,
  - UI poll trạng thái job.

Với cách này, AI vẫn chỉ xử lý lớp tổng hợp (không ingest toàn bộ HTML), nên vừa scale tốt vừa kiểm soát chi phí token.

## Bản community share: cấu hình AI ngay trên giao diện
Phiên bản này không bắt buộc dùng biến môi trường Vercel cho AI/Auth.
Người dùng tự nhập trực tiếp trên UI:
- Provider (`openai`, `gemini`, `claude`, `grok`, `openrouter`, `custom`)
- API key
- Model
- (Custom) Base URL + API style (`chat` hoặc `responses`)

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
