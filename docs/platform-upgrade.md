# Kế hoạch nâng cấp nền tảng — EPUB Reader

> Ngày: 2026-09-20 · Trạng thái: **13/21 mục backlog đang theo dõi đã xong và có test (EPR-02 đã bỏ theo quyết định 2026-09-21; EPR-22 xong, riêng 22.7 chờ Secret WebDAV); 2 mục cần chủ hệ thống (mục 9); 6 mục chưa làm (EPR-14, 15, 16, 19, 20, 21).** Sự cố upload ngày 2026-09-20 ở mục 12; kế hoạch tương thích với app vBook trên điện thoại ở mục 13.
>
> Phương pháp lấy từ `Worker_Zalo/docs/platform-upgrade/` (baseline có bằng chứng → ưu tiên P0–P3 → quyết định cần chốt → lộ trình có cổng thoát → backlog có ID → chỉ số nghiệm thu → sổ rủi ro), thu nhỏ cho dự án một người: một file thay vì tám.

## 1. Mục tiêu

Ứng dụng đã chạy ổn trên k3s. Việc còn lại không phải thêm tính năng mà là làm cho nó **đáng tin khi để trên internet**: không ai đoán được mật khẩu, không mất sách khi hỏng đĩa hoặc xoá nhầm, bản mới lên cụm mà không phải nhớ làm tay, và mọi lỗi phải bị test bắt trước khi ra production.

## 2. Baseline đã xác minh (2026-09-20)

| Hạng mục | Kết quả | Cách kiểm |
|---|---|---|
| Nạp sách 2953 chương (22 MB .epub) | ~3,3 s qua giao diện, so từng chương với parse độc lập: **0/2953 lệch** | Playwright + script so sánh, trên server Node |
| Sống sót khi tiến trình chết giữa lúc nạp | Tiếp tục đúng, không sót file rác | Kill cứng rồi bật lại (giờ là test tự động) |
| Trang đăng nhập trên internet | Mở công khai, **không có Cloudflare Access** | `curl` tới `vs.dophamnguyen.xyz`: 200, không thử thách |
| Header bảo mật | **Không có** header nào (CSP, X-Frame-Options...) | `curl -I` |
| Backup / Image Updater / NetworkPolicy trong `ci-cd-platform` | Không có cho app nào | `grep` toàn repo |
| Test tự động (trước đợt này) | **0** | Repo không có thư mục test; CI chỉ build image |

Từ code (không cần đo): `/api/auth` không giới hạn số lần thử; phiên 30 ngày kiểu stateless nên đăng xuất không thu hồi được; probe chỉ gọi `/` tĩnh; sách nạp dở bị ẩn và không xoá được từ UI (đã thấy multipart "Ongoing" treo trên R2); hai request nạp song song cho cùng một sách dùng chung con trỏ resume.

## 3. Quyết định cần chốt (đã chọn mặc định, đổi được)

1. **Đường Cloudflare Worker: giữ nhưng coi là legacy.** Toàn bộ logic chia chunk/multipart/staging chỉ tồn tại để né giới hạn CPU của Workers Free; trên Docker không cần. Khi chắc chắn không quay lại Cloudflare thì xoá được khoảng 150 dòng và đơn giản hoá ingest thành một request.
2. **Một người dùng.** Mật khẩu chung, không tài khoản. Nếu sau này cần nhiều người thì phải thêm `user_id` vào `books`/`progress` từ đầu, đừng vá.
3. **Chặn truy cập: passcode + giới hạn thử (đã làm). Không dùng Cloudflare Access** — chủ hệ thống quyết định không cần (2026-09-21). Rủi ro của trang đăng nhập công khai được chấp nhận và giảm bằng giới hạn thử, thu hồi phiên, CSP và log; nếu sau này đổi ý thì đây là việc S (xem EPR-02).
4. **Backup: cùng node là mức tối thiểu, off-site là bắt buộc thật sự.** Backup hiện tại chống được hỏng dữ liệu/xoá nhầm/nâng cấp lỗi nhưng **không** chống được mất đĩa hoặc node.

## 4. Nguyên tắc

- Không thêm tính năng mới trước khi đóng P0.
- Không coi "pod Running" hay "HTTP 200" là bằng chứng hệ thống tốt: backup chỉ được tính khi **đã khôi phục thử thành công**.
- Không xoá dữ liệu người dùng trong tác vụ nền nếu chưa chứng minh được nó là rác (xem `ever_completed`).
- Mọi lỗi đã gặp phải có test tái hiện; mọi test phải từng thấy nó đỏ (đã làm mutation check cho khoá ingest, dọn rác, chặn đọc khi đang index).

## 5. Backlog

Trạng thái: ✅ xong + có test · ⏳ cần chủ hệ thống · 🔲 chưa làm · ⛔ đã bỏ. Effort: S 1–2 giờ, M nửa ngày, L nhiều ngày.

| ID | Ưu tiên | Việc | Effort | TT | Điều kiện hoàn thành |
|---|---|---|---|---|---|
| EPR-01 | P0 | Giới hạn thử đăng nhập: 5 lần/15 phút/client + trần toàn cục 60 | S | ✅ | Lần 6 → 429 kể cả đúng mật khẩu; client khác không bị ảnh hưởng; trần toàn cục chặn được địa chỉ giả |
| EPR-02 | P0 | ~~Cloudflare Access trước `vs.dophamnguyen.xyz`~~ **Bỏ** theo quyết định của chủ hệ thống (2026-09-21) | S | ⛔ | Không làm; rủi ro được chấp nhận (quyết định 3). Muốn làm lại: Zero Trust → Access → Applications → thêm host, policy theo email |
| EPR-03 | P0 | Commit SealedSecret vào git | S | ✅ | `apps/epub-reader/sealedsecret.yaml` có trong `ci-cd-platform` (commit `4b74170`) |
| EPR-04 | P1 | CronJob backup hằng đêm (snapshot SQLite `VACUUM INTO` + mirror `objects/`, giữ 14 bản) | M | ✅ | **Diễn tập khôi phục tự động**: backup → xoá sạch dữ liệu → restore → mọi chương khớp từng byte. **Đã chạy trên volume thật của cụm (2026-09-20):** backup 3 file/38 MB; khôi phục vào thư mục tạm: `integrity_check` ok, 1 sách/2389 chương/3 file, 4 giây |
| EPR-05 | P1 | Backup **off-site** | M | ⏳ | Bản sao nằm ngoài node/đĩa đang chạy app và đã khôi phục thử từ đó |
| EPR-06 | P1 | Test + cổng CI: typecheck + 31 test; đỏ thì không đẩy image | M | ✅ | PR/push chạy `npm test`; job build phụ thuộc job test |
| EPR-07 | P1 | Tự ghim tag `:<sha>` vào manifest để cụm tự cập nhật | S | ⏳ | Cần secret `CI_CD_PLATFORM_TOKEN`; xanh → commit vào `ci-cd-platform` → ArgoCD rollout |
| EPR-08 | P1 | Khoá ingest theo từng sách (409 khi trùng) | S | ✅ | 4 request song song → có 409, dữ liệu vẫn đúng từng byte |
| EPR-09 | P1 | Dọn upload dở sau 24 giờ, **không bao giờ** dọn sách đang reindex | M | ✅ | Test khởi động lại với ngưỡng 0: upload dở bị xoá cả file, sách đang reindex còn nguyên và hoàn tất được |
| EPR-10 | P1 | Chặn zip bomb (giới hạn dung lượng giải nén trước khi giải nén) | S | ✅ | Chương khai 40 MB → 422 "too large", server vẫn khoẻ, xoá được |
| EPR-11 | P2 | Header bảo mật (CSP chặt, X-Frame-Options, nosniff, Referrer-Policy, HSTS) + `no-store` cho API | S | ✅ | Trình duyệt thật: 0 vi phạm CSP, toàn bộ luồng UI chạy |
| EPR-12 | P2 | Thu hồi phiên ("Sign out everywhere", epoch trong token) | M | ✅ | Đăng xuất ở một thiết bị → mọi cookie cũ đều 401 |
| EPR-13 | P2 | `/healthz` kiểm tra DB thật + dung lượng đĩa; readiness dùng nó | S | ✅ | DB hỏng → 503 → pod ra khỏi Service |
| EPR-14 | P2 | Cảnh báo đĩa sắp đầy (~80 MB/sách lớn) | S | 🔲 | Log `LOW DISK` (đã có) được đẩy thành cảnh báo qua hệ thống alert hiện có |
| EPR-15 | P2 | Bỏ đường Cloudflare Worker (xem quyết định 1) | M | 🔲 | Ingest một request, xoá staging/multipart, `deploy.yml` |
| EPR-16 | P3 | Nhiều người dùng (tìm kiếm toàn văn đã chuyển sang EPR-22.5) | L | 🔲 | Chỉ làm khi quyết định 2 đổi |
| EPR-17 | P1 | Tải lên theo mảnh 256 KB (thử lại từng mảnh, song song 3, có tiến độ, `complete` lặp lại an toàn) + báo rõ khi upload bị cắt | M | ✅ | File 22 MB qua trình duyệt thật, cố ý làm hỏng 4 mảnh (đứt kết nối ×2, 504, 429): vẫn ra đủ 2953 chương và đúng một cuốn sách; 6 test tích hợp |
| EPR-18 | P1 | Phát hiện EPUB bị cụt (tải dở) **ngay trong trình duyệt** trước khi gửi byte nào, và server báo "cut off" thay vì `invalid zip data` | S | ✅ | File 22 MB thật: bản đủ qua, bản cắt còn 20 MiB bị chặn; 1 test tích hợp mới (32/32 xanh); đã chạy trên cụm (`b6b632d`) |
| EPR-19 | P2 | **Nhập bản sao lưu vBook** (`.tar.zst`) qua web: sách có nội dung + tiến độ đọc (mục 13) | L | 🔲 | Nhập đúng file mẫu 14 sách/7 sách có chương; sách đã có không bị tạo trùng; tiến độ khớp; test bằng bản sao lưu giả nhỏ |
| EPR-20 | P2 | **WebDAV chỉ đọc** để vBook duyệt và nhập sách từ EPUB reader (mục 13) | M | 🔲 | vBook trên điện thoại thấy danh sách và nhập được một cuốn; sai mật khẩu / thử quá nhiều lần bị chặn |
| EPR-21 | P3 | Đưa **tiến độ đọc về vBook** bằng một bản sao lưu nhỏ mà vBook khôi phục ở chế độ gộp (mục 13) | M | 🔲 | Thử trên **bản sao/dữ liệu thử** trước; chỉ tính xong khi vBook trên điện thoại hiện đúng chương đã đọc mà không mất dữ liệu khác |
| EPR-22 | P2 | 11 tính năng học từ vBook — **kế hoạch chi tiết ở mục 14** (EPR-22.0 … 22.12, 4 giai đoạn có cổng thoát; **mọi giao diện phụ trợ nằm trong view Extensions**) | M–L | ✅ | Từng việc con có test riêng; cổng thoát của giai đoạn ở mục 14.5 |

Sửa kèm theo: ghi tiến độ đọc cho sách không tồn tại giờ trả 404; đọc chương khi sách đang index dở trả 409 (trước đó có thể trả sai nội dung vì offset mới trỏ vào file cũ); so sánh mật khẩu bằng HMAC nên không lộ độ dài.

## 6. Lộ trình và cổng thoát

| Giai đoạn | Nội dung | Cổng thoát (đo được) | TT |
|---|---|---|---|
| 0 – 72 giờ | EPR-01, 03 (EPR-02 đã bỏ) | Gõ sai 5 lần → 429; secret có trong git | 2/2 xong |
| Tuần 1–2 | EPR-04…10 | Diễn tập khôi phục 0 chương lệch; CI đỏ thì không sinh image; bản mới tự lên cụm | backup + khôi phục đã chứng minh trên cụm thật; còn 05, 07 |
| Tuần 3–4 | EPR-11…14 | 0 vi phạm CSP; backup off-site đã khôi phục thử; có cảnh báo đĩa | code xong; còn 14 |
| Sau đó | EPR-15, 16 | Theo quyết định 1 và 2 | chưa bắt đầu |

## 7. Chỉ số nghiệm thu

| Chỉ số | Mục tiêu | Hiện tại |
|---|---|---|
| Nạp sách 3000 chương | p95 < 30 s | ~3,3 s |
| Toàn vẹn sau khôi phục | 0 chương lệch | 0/40 (test), 0/2953 (đo tay); cụm thật: `integrity_check` ok, 2389 chương có mặt (chưa so nội dung từng chương, xem lưu ý dưới bảng) |
| RPO (mất dữ liệu tối đa) | 24 giờ | 24 giờ **nhưng cùng node** |
| RTO (thời gian khôi phục) | 30 phút | Job khôi phục 37 MB: 4 giây (chưa gồm ngừng app/ArgoCD và dữ liệu lớn hơn) |
| Test | 100% pass trước khi có image | 31/31, ~12 s |
| Vi phạm CSP | 0 | 0 |

Lưu ý: diễn tập trên cụm mới kiểm tra `integrity_check`, số sách/chương và số file trên bản khôi phục, chưa khởi động app trên dữ liệu đó. Việc so nội dung từng chương sau khôi phục được chứng minh bởi `tests/backup.test.ts` trên máy phát triển. Đo RTO thật cần chạy đủ runbook (ngừng app → khôi phục vào PVC dữ liệu → bật lại), lúc đó là dữ liệu thật của người dùng nên chỉ làm khi cần.

**Definition of Done cho một thay đổi:** có test tái hiện lỗi/tính năng; `npm run typecheck` và `npm test` xanh; nếu đụng migration thì dựng được DB mới từ đầu; nếu đụng luồng UI thì chạy thử trong trình duyệt thật, không chỉ `node --check`.

**Release gate:** PR → typecheck + test. `main` → thêm build arm64. Sau khi có `CI_CD_PLATFORM_TOKEN` → tự ghim tag. Việc còn thiếu là gate staging: hiện chưa có môi trường thử trên cụm.

## 8. Sổ rủi ro và điều kiện dừng mọi việc khác

| Rủi ro | Xác suất | Ảnh hưởng | Giảm thiểu / kế hoạch dự phòng |
|---|---|---|---|
| Mất đĩa/node `ubuntu-16gb` khi backup còn cùng node | Thấp | **Mất toàn bộ sách** | EPR-05. Giữ file `.epub` gốc ở máy cá nhân cho đến khi có off-site |
| Mất khoá giải mã Sealed Secrets (chưa backup, đã ghi trong ARCHITECTURE.md) | Thấp | Mất khả năng tạo lại secret | Lưu lại `ACCESS_PASSCODE`; secret tạo lại được trong vài phút |
| Trần đăng nhập toàn cục bị lợi dụng để khoá chủ | Trung bình | Chủ không đăng nhập được tối đa 15 phút | Chấp nhận (đã ghi trong code); khởi động lại pod xoá bộ đếm; không có Cloudflare Access nên trang đăng nhập công khai là bề mặt tấn công chính (đã chấp nhận) |
| `node:sqlite` vẫn ở mức "experimental" trong Node 24 | Thấp | API đổi khi nâng Node | Ghim `node:24`; test chạy trên đúng phiên bản đó ở CI |
| Rollout dùng `Recreate` nên có vài giây gián đoạn | Chắc chắn | Thấp | Chấp nhận: SQLite chỉ có một tiến trình ghi |

**Stop-the-line:** (1) diễn tập khôi phục đỏ; (2) bất kỳ chương nào trả sai nội dung; (3) CI đỏ mà image vẫn được đẩy. Gặp một trong ba thì dừng mọi việc khác.

## 9. Việc cần chủ hệ thống làm

1. **EPR-07** — tạo fine-grained PAT (Contents: read & write trên `Npham140201/ci-cd-platform`), lưu thành secret `CI_CD_PLATFORM_TOKEN` của repo EPUB Reader.
2. **EPR-05** — chọn nơi đặt bản sao off-site (ví dụ kéo `/backup` sang node khác qua Tailscale bằng `rsync`, hoặc đẩy lên một bucket) rồi tôi viết bước đó.

## 10. Runbook khôi phục

Điều kiện: có volume `epub-reader-backup` (hoặc bản sao off-site của nó).

1. Ngừng app: `kubectl scale deploy/epub-reader --replicas=0`.
2. Nếu volume dữ liệu còn nhưng hỏng: đổi tên/xoá PVC `epub-reader-data` rồi để ArgoCD tạo lại PVC rỗng. Công cụ **từ chối ghi đè** khi đã có `app.sqlite`.
3. Chạy Job một lần với cùng image và lệnh `node --disable-warning=ExperimentalWarning backup.mjs restore`, mount `epub-reader-data` vào `/data` và `epub-reader-backup` vào `/backup`.
4. Bật lại: `kubectl scale deploy/epub-reader --replicas=1`, đăng nhập, kiểm tra danh sách sách và mở vài chương.
5. Sách nào đang nạp dở lúc backup sẽ tự được tiếp tục khi mở (hoặc bị dọn sau 24 giờ nếu chưa từng nạp xong).

Toàn bộ quy trình này chạy tự động trong `tests/backup.test.ts` (backup → xoá sạch → restore → so từng chương), nên nếu test xanh thì công cụ khôi phục dùng được; phần chưa được kiểm chứng là chạy trên volume thật của cụm.

## 11. Việc còn lại — đã ghi, chưa làm (tạm hoãn theo yêu cầu 2026-09-20)

Thứ tự đề xuất khi quay lại: EPR-05 → 07 → 14 → 15 (EPR-02 đã bỏ). EPR-16 chỉ khi quyết định 2 đổi. Nhóm tương thích vBook (mục 13) làm theo thứ tự EPR-19 → 20 → 21; EPR-22 (mục 14) độc lập, trừ hai việc dùng chung bộ ghép EPUB với EPR-19.

| ID | Ai làm | Cần gì để bắt đầu | Việc cụ thể |
|---|---|---|---|
| EPR-05 | Cả hai | **Chọn nơi đặt bản sao**: (a) `rsync` `/backup` sang node khác qua Tailscale (rẻ nhất, dùng hạ tầng có sẵn, cần đường SSH/khoá giữa hai node), hoặc (b) bucket (R2 / Oracle Object Storage, cần khoá truy cập), hoặc (c) một máy chủ WebDAV bạn có (EPR-22.7, mục 14) | Viết bước sao chép ra ngoài node vào CronJob; sau đó **diễn tập khôi phục từ bản sao off-site** (chưa khôi phục thử được thì chưa tính là xong) |
| EPR-07 | Chủ hệ thống | Tạo PAT fine-grained: Contents read & write trên `Npham140201/ci-cd-platform` | Lưu thành secret `CI_CD_PLATFORM_TOKEN` của repo EPUB Reader; job `pin-image` đã viết sẵn sẽ tự chạy. Kiểm tra: push một commit → xuất hiện commit "epub-reader: image ..." trong `ci-cd-platform` |
| EPR-14 | Tôi | **Chọn hệ thống cảnh báo** (Beszel / eBOSS_LOG / Zalo). App đã ghi log `LOW DISK` khi dưới 10% và `/healthz` trả `disk.free_pct`; đĩa của PVC là đĩa của node, và Beszel đã theo dõi đĩa host nên có thể chỉ cần đặt ngưỡng ở đó | Nối log/số liệu vào cảnh báo, thử bằng cách hạ ngưỡng tạm để thấy cảnh báo bắn |
| EPR-15 | Tôi | **Chốt quyết định 1**: không quay lại Cloudflare. Nên đợi vài tuần chạy ổn trên k3s rồi mới bỏ vì không quay lại được | Ingest một request; xoá staging/multipart trong `src/index.ts`; xoá `deploy.yml`, `scripts/upload-book.ts`, `wrangler.jsonc` và phụ thuộc `wrangler`; giữ test xanh |
| EPR-16 | Tôi | Chỉ khi bạn muốn nhiều người dùng (tìm kiếm toàn văn giờ là EPR-22.5) | Thêm `user_id` vào `books`/`progress` từ đầu, không vá |
| EPR-19 | Tôi | **Hai câu trả lời** ở mục 13.5 (sách đã có thì giữ hay tạo mới; điện thoại có Tailscale không). Có sẵn file mẫu để thử | Nút "Nhập bản sao lưu vBook" dùng đường upload theo mảnh; giải nén zstd theo luồng; ghép EPUB trong bộ nhớ rồi đưa qua đường nhập sách hiện có |
| EPR-20 | Cả hai | Quyết định có mở WebDAV ra ngoài không (mục 13.4) | PROPFIND/GET chỉ đọc, mật khẩu riêng, giới hạn thử sai; dựng EPUB khi vBook tải (app không giữ file EPUB gốc) |
| EPR-21 | Cả hai | Điện thoại để thử khôi phục; **làm sau EPR-19** | Sinh bản sao lưu tối thiểu; thử ở chế độ "Gộp" hoặc "Chỉ khôi phục phần thiếu" trên dữ liệu thử |
| EPR-22 | Tôi | Chốt 5 quyết định ở mục 14.3 (đều đã có mặc định) | Bắt đầu với giai đoạn A (mục 14.5) |

Việc chưa kiểm chứng cần nhớ: diễn tập khôi phục trên cụm chưa khởi động app trên dữ liệu đã khôi phục, và chưa đo RTO của cả runbook (mục 7).

## 12. Sự cố 2026-09-20: upload chậm rồi báo "invalid zip data"

**Triệu chứng.** Upload đứng ở "parsing…" rất lâu; với file 22 MB thì báo `could not parse EPUB: invalid zip data` dù file gốc là zip hợp lệ.

**Đo được (từ máy người dùng, qua Cloudflare Tunnel):**
- Tải tới Cloudflare Singapore: 7,6 MB trong 3,2 giây (bình thường).
- Tải tới pod qua tunnel: 25–80 KB/s, và Cloudflare trả 504 sau 100 giây. Request nhỏ vẫn ổn (0,5–2,5 giây).
- Log pod: hai dòng `POST /api/books 400 60005ms`: request bị cắt đúng 60 giây, body cụt nên `formData` lỗi hoặc ghép ra file thiếu phần đuôi.

**Nguyên nhân (hai thứ chồng nhau):**
1. **MTU của pod là 1280** trong khi Tailscale cũng chỉ 1280 mà VXLAN cần thêm khoảng 50 byte, nên gói lớn bị phân mảnh/rớt (`packetization-layer-pmtud-mode: blackhole` khiến nó bò chứ không đứng). Đường đi lại băng qua mạng giữa các node tới hai lần: `cloudflared` (ubuntu-16gb hoặc vps-24gb) → Traefik (ubuntu-8gb) → app (ubuntu-16gb).
2. **Traefik v3 cắt request sau 60 giây** (`readTimeout` mặc định), mà chưa có gì trong app phân biệt "body bị cắt" với "file hỏng".

**Đã làm:**
- Trong app (EPR-17): tải theo mảnh nhỏ nên không còn request nào dài; thiếu/cụt thì báo rõ. Đây là lớp bảo vệ độc lập với chất lượng mạng.
- Người dùng đặt `mtu: "1230"` trong `cilium-config`, khởi động lại agent và tạo lại pod app/Traefik/cloudflared; pod app đã lên MTU 1230.

**Chưa kiểm chứng (nhớ kiểm tra):**
- Tốc độ sau khi sửa MTU chưa đo sạch: lần đo ngay sau khi thay pod trúng lúc `cloudflared` đang kết nối lại (lỗi 1033/530), nên số liệu không dùng được.
- Nghi vấn cần loại trừ: QUIC (cloudflared mặc định) cần gói UDP khoảng 1252 byte, mà pod MTU 1230 có thể làm nó phải rớt về HTTP/2. Nếu tunnel chập chờn, xem `kubectl logs deploy/cloudflared`; cách né là đặt `TUNNEL_TRANSPORT_PROTOCOL=http2` cho Deployment cloudflared.
- `cloudflared` đã restart 50 và 59 lần trong 48 ngày trước cả sự cố này; chưa rõ vì sao.
- Bản hoàn tác MTU: xoá khoá `mtu` khỏi `cilium-config` rồi khởi động lại DaemonSet cilium.

## 13. Tương thích với vBook (ứng dụng trên điện thoại)

**Mục tiêu (ý người dùng):** app này do bạn tự viết và phải tương thích với **vBook đang dùng trên điện thoại** — sách tải bên vBook sang được EPUB reader, và tiến độ đọc bên EPUB reader về lại vBook. Không sao chép code hay giao diện của vBook; chỉ đọc định dạng dữ liệu của chính bạn để hai bên nói chuyện được.

### 13.1 Bằng chứng đã thu thập (2026-09-21)

- `vBook-1.0.1.msi` (bản Windows, 171 MB, không có chữ ký số, nhà sản xuất "Unknown") chỉ được **giải nén vào thư mục tạm để xem cấu trúc**, không cài, không chạy. Là app Kotlin/Compose chạy trên JVM; script extension chạy bằng Rhino; có sẵn WebDAV / Google Drive / OneDrive / OPDS làm "nguồn sách", và WebDAV / Google Drive làm nơi sao lưu.
- `backup_20260921_083231.tar.zst` (48 MB, do bạn xuất từ điện thoại Android, `backup_version: 1`) đã được giải nén và đọc. Không thấy mật khẩu/token trong các file JSON. File nằm ở thư mục gốc dự án, **chưa git-ignore, đừng `git add .`**.

### 13.2 Định dạng bản sao lưu vBook

Tar nén zstd (giải nén bằng `zlib.zstdDecompress` có sẵn trong Node 24).

| Đường dẫn | Nội dung |
|---|---|
| `manifest.json` | `device_id`, `device_name`, `backup_version`, `create_at` (ms) |
| `books/<id>/book.json` | tên, tác giả, bìa (URL), nguồn, `path` (URL trang gốc), `total_chapter`, **`last_read_chapter_index`**, **`last_read_chapter_percent`** (0–1), **`last_read`** (ms), `total_read_time` |
| `books/<id>/toc_links.json` | tên từng chương (`title.raw`), `position` |
| `books/<id>/chapters.json` | `id = <bookId>_<vị trí>`, `position`, `downloaded`, `last_read` |
| `books/<id>/contents/<bookId>_<n>/raw.txt` | **nội dung chương**, HTML đơn giản (`<body>` tiêu đề `<br><br>` đoạn văn…) |
| `books/<id>/contents.json`, `bookmarks.json`, `cover` | chỉ mục chương đã tải, đánh dấu, ảnh bìa |
| `read_histories.json` | các phiên đọc (`read_time`, `create_at`) — **không gắn với sách**, chỉ hợp cho thống kê |

File mẫu: 14 sách, **7 có nội dung đã tải** (~11.600 chương), 7 chỉ có thông tin + tiến độ. Đây là bản sao lưu **nguyên khối**, không phải đồng bộ từng bản ghi; khôi phục do người dùng bấm, có 3 chế độ (gộp / chỉ thêm phần thiếu / thay thế toàn bộ).

### 13.3 Thiết kế

- **Một bộ ghép EPUB dùng chung** (chương → EPUB trong bộ nhớ): EPR-19 dùng nó để đưa sách vBook qua đường nhập hiện có (đã có test), EPR-20 dùng nó để dựng file khi vBook tải.
- **Ghép sách:** lưu `vbook_id` (và `source`/`path`) trong bảng `books`; sách chưa có thì ghép theo tên + tác giả, sai thì người dùng chọn tay. Sách không có nội dung chỉ lưu tiến độ, không tạo sách đọc được.
- **Tiến độ:** vBook = chỉ số chương + phần trăm trong chương; EPUB reader = chỉ số chương + dòng. Chỉ đồng bộ chắc ở mức chương; phần trăm quy đổi gần đúng. Khi hai bên khác nhau thì lấy bên có mốc thời gian mới hơn, nhưng tiến độ không bao giờ lùi (giống chế độ "chỉ tiến" của vBook).
- **Ba hướng:** A = EPUB reader → vBook (sách, qua WebDAV chỉ đọc); B = vBook → EPUB reader (sách + tiến độ, qua nhập bản sao lưu); C = tiến độ về lại vBook. B an toàn nhất; C rủi ro nhất (bản sao lưu thiếu định dạng có thể làm khôi phục hỏng hoặc ghi đè dữ liệu vBook, và chưa biết vBook xử lý bản sao lưu một phần thế nào) nên phải thử trên dữ liệu thử.

### 13.4 Ràng buộc hạ tầng — vì sao không đẩy bản sao lưu qua WebDAV công khai

vBook đẩy sao lưu lên WebDAV bằng **một request** (`PUT` cả file, tên `vbook_yyyyMMdd_HHmmss.tar.zst`). Qua `vs.dophamnguyen.xyz` sẽ gặp lại lỗi cũ: Traefik cắt request sau **60 giây**, tunnel từng đo 25–80 KB/s khi tải lên (đã đổi MTU nhưng **chưa đo lại**), và Cloudflare gói miễn phí giới hạn body **100 MB** (file mẫu đã 48 MB, sẽ lớn thêm). Vì vậy:
- Bản sao lưu lớn → nhập bằng nút trên web, dùng đường upload theo mảnh đã chạy được (EPR-19), không mở thêm cửa ra internet.
- WebDAV chỉ dùng cho việc nhỏ: vBook đọc sách (EPR-20) và nhận tiến độ (EPR-21, file vài KB). Nếu mở ra ngoài: mật khẩu riêng tách khỏi passcode chính, chỉ đọc, giới hạn thử sai như đăng nhập; tốt nhất chỉ cho vBook vào qua Tailscale.

### 13.5 Câu hỏi còn treo (đã có mặc định, đổi được)

1. **Sách vBook mà EPUB reader đã có** (ví dụ Trạch Nhật Phi Thăng nếu đã nhập): mặc định **giữ bản đang có và chỉ cập nhật tiến độ**; đổi sang "nhập thành bản mới" nếu bạn muốn.
2. **Điện thoại có Tailscale (hoặc cài được) không?** Quyết định WebDAV có cần mở công khai hay không (EPR-20).

### 13.6 Tính năng nên học từ vBook (EPR-22; **kế hoạch chi tiết ở mục 14**)

Nguồn: chuỗi giao diện tiếng Việt và tên gói của vBook. Ý tưởng, không sao chép. Chia cụm:
1. **Nhỏ, thấy ngay:** tải trước chương kế; kệ sắp theo đọc gần nhất + hiện % tiến độ; nhắc nghỉ mắt và "còn X phút trong chương"; chủ đề màu kiểu VS Code (Dark+/Light+/Monokai).
2. **Giá trị lớn nhất:** đồng bộ highlight/cài đặt lên server (hiện nằm trong `localStorage` từng trình duyệt), kèm bookmark.
3. **Thống kê và nhập:** biểu đồ hoạt động đọc kiểu GitHub (hợp với vỏ "docs"); nhập TXT tự chia chương (regex tự viết).
4. **Sau cùng:** sao lưu lên WebDAV (nối với EPR-05), xuất sách ra EPUB/TXT, tìm kiếm (EPR-16).

Không làm: dịch máy, OCR, đọc thành tiếng bằng AI, extension/chuyển nguồn, cộng đồng (không hợp mục đích đọc kín đáo). Nhập từ URL/OPDS chỉ làm nếu có danh sách nguồn được phép (nguy cơ SSRF).

### 13.7 Việc chưa kiểm chứng

- Chưa thử vBook thật với một máy chủ WebDAV nào, nên **cách vBook duyệt và nhập từ WebDAV** (`PROPFIND` độ sâu nào, yêu cầu đặc biệt nào) mới đoán qua tên lớp; EPR-20 phải kiểm chứng bằng điện thoại.
- Chưa biết vBook khôi phục thế nào khi bản sao lưu chỉ có một phần dữ liệu (EPR-21).
- Định dạng nội dung `raw.txt` chỉ thấy ở nguồn Tàng Thư Viện; nguồn khác có thể khác (thử với sách Truyện Full khi có nội dung).

## 14. Kế hoạch: 11 tính năng học từ vBook (EPR-22.1 – 22.11, cộng 22.0 bộ ghép EPUB dùng chung và 22.12 khung Extensions)

Chỉ là kế hoạch, **chưa làm**. Ý tưởng lấy từ chuỗi giao diện của vBook; mọi thứ tự thiết kế và viết lại, không sao chép.

### 14.1 Baseline đã xác minh trong code (2026-09-21)

| Vùng | Hiện trạng | Hệ quả |
|---|---|---|
| Tiến độ | Bảng `progress` một dòng/sách; `POST /api/books/:id/progress` **ghi đè theo request cuối** (không so mốc thời gian). Client lưu sau 700 ms khi cuộn, và bằng `sendBeacon` khi ẩn tab | Hai thiết bị ghi đè nhau, tiến độ có thể lùi |
| Highlight | `localStorage` khoá `devdocs.hl:<sách>:<chương>` = mảng `{p, start, end}` (đoạn + vị trí ký tự) | Không sang máy khác, mất khi xoá dữ liệu trình duyệt, **không nằm trong backup** |
| Cài đặt | `localStorage` khoá `devdocs.settings`: `blurHide, camo, serif, readFocus, fontSize, readWidth, panicCode`; tab đang mở ở `devdocs.session` | Mỗi thiết bị một bộ |
| Danh sách sách | `GET /api/books` không trả tiến độ; tiến độ chỉ có khi mở `/index` của từng sách | Explorer không hiện được % |
| Giao diện | Màu là biến CSS ở `:root` (89 chỗ dùng `var(--…)`), màn hình boss key (`.panic`) dùng cùng biến | Đổi theme khá rẻ, nhưng **màn boss key phải đổi theo**, không thì hiện màn tối trong IDE sáng là lộ |
| Chưa có | bookmark, thống kê, tìm kiếm (icon Search/Source Control ở activity bar chỉ để trang trí), theme, xuất sách, nhập TXT (tải trước chương thì **đã có** — `prefetchAround`, xem 14.9) | |
| FTS5 | Đã thử: `node:sqlite` có FTS5; `unicode61 remove_diacritics 2` bỏ dấu tiếng Việt đúng (tìm "trach nhat" ra "Trạch Nhật") **trừ chữ đ** ("dao" không ra "đạo") | Cần đổi đ→d ở cả lúc lập chỉ mục lẫn lúc tìm. Thử lại trên Node 24 của image khi làm |

### 14.2 Nguyên tắc

- Dữ liệu người dùng (highlight, bookmark, cài đặt, thống kê) **sống ở SQLite trên server** để được backup; `localStorage` chỉ là bộ nhớ đệm/ngoại tuyến.
- Migration chỉ **thêm** (bảng/cột mới), không sửa hay xoá cái cũ; dữ liệu cũ trong `localStorage` được **nhập lên server đúng một lần**, không mất.
- Không thêm phụ thuộc nặng. Việc nào làm được hoàn toàn ở trình duyệt thì làm ở trình duyệt.
- Không lộ vỏ ngụy trang: chữ mới dùng từ vựng của VS Code ("Activity", "Bookmarks", "Problems"…); mọi màn hình mới phải theo theme hiện tại, kể cả màn boss key. **Mọi giao diện phụ trợ nằm trong view Extensions** (mục 14.8); Explorer, editor, tab và status bar giữ nguyên.
- Mỗi việc có test tích hợp như hiện nay, cộng kiểm tra bằng trình duyệt thật (Playwright) cho phần giao diện.

### 14.3 Quyết định cần chốt (đã chọn mặc định, đổi được)

1. **Chỉ cần chạy trên Docker/k3s.** Tính năng mới không bắt buộc chạy trên đường Cloudflare Worker (xem EPR-15); code Worker vẫn phải qua `typecheck`.
2. **"Chỉ tiến" nghĩa là gì.** Lưu **hai** giá trị: *xa nhất* (`furthest_idx`, `furthest_ratio`; chỉ tăng, dùng cho % và cho vBook) và *vị trí hiện tại* (`chapter_idx`, `scroll_ratio`, kèm mốc thời gian của thiết bị, theo "mới hơn thắng"; dùng cho "tiếp tục đọc"). Nếu chỉ giữ xa nhất thì đọc lại chương cũ rồi mở lại sẽ nhảy về tận chương xa.
3. **Cài đặt nào đồng bộ.** Tất cả trừ tab đang mở (theo thiết bị). `panicCode` và `blurHide` cũng đồng bộ (nằm sau đăng nhập; đổi ở một máy là đổi ở mọi máy).
4. **Cách đo thời gian đọc.** Chỉ tính khi tab hiện, chưa boss key, và có cuộn/phím trong 60 giây gần nhất; không lưu nội dung nào. Gửi gộp mỗi 60 giây.
5. **Nhập TXT.** Luôn **xem trước danh sách chương** trước khi nhập; nếu không nhận ra tiêu đề chương thì chia theo độ dài (mặc định ~20.000 ký tự) thay vì từ chối.
6. **Giao diện phụ trợ = extension** (yêu cầu 2026-09-21, sau khi xem ảnh chụp app đang chạy). Mỗi tính năng là một "extension" nội bộ trong view Extensions, bật/tắt được, xem mục 14.8. Kể cả tìm kiếm: nằm ở extension **Global Search**, không ở icon Search; nếu muốn ô Search thật ở icon Search thì chỉ đổi chỗ đặt của 22.5.

### 14.4 Từng việc

Effort: XS < 1 giờ · S 1–2 giờ · M nửa ngày · L nhiều ngày. Ước lượng thô, chưa có bằng chứng thực tế.

| ID | Việc | Thiết kế | Dữ liệu / API | Nghiệm thu | Effort | Cần trước |
|---|---|---|---|---|---|---|
| 22.12 | **Khung Extensions** (làm đầu tiên; mọi giao diện phụ trợ dựa vào nó) | Icon Extensions mở view "EXTENSIONS" ngay trong sidebar hiện có: ô lọc (lọc thật), mục "INSTALLED" liệt kê các extension nội bộ (biểu tượng, tên, phiên bản, mô tả, nhà phát hành "devdocs", bánh răng Disable/Enable). Bấm một extension → tab "Extension: <tên>" trong editor (như trang chi tiết của VS Code). Thêm loại tab `ext:<id>` (lưu trong session như tab sách). Bật/tắt từng extension là một khoá cài đặt. Icon Search/Source Control/Run hiện view rỗng như VS Code thật | Khoá cài đặt `extensions` (lưu local trước, đồng bộ khi 22.1 xong); không đổi DB | Playwright: mở/đóng view và tab không đổi hộp bao 5 vùng; tắt một extension thì mọi dấu vết của nó biến mất; mặc định giao diện ngoài view Extensions giống hệt hiện tại | M | — |
| 22.10 | Tải trước chương kế (**đã có sẵn** `prefetchAround`; chỉ còn chỉnh nhỏ, xem 14.9) | Sau khi vẽ chương `idx`, lúc rảnh (`requestIdleCallback`) lấy `idx+1` vào bộ đệm nhỏ (3 chương). Bỏ qua khi tab ẩn/boss key | Không đổi server | Mở chương kế không thấy chờ; số request thừa không quá 1 chương | XS | — |
| 22.9 | Kệ sách: sắp xếp + % | `GET /api/books` trả thêm `furthest_*` và `last_read_at`; trang **Library** trong Extensions có sắp xếp (đọc gần nhất / mới thêm / tên / %) và hiện % cạnh mỗi sách; **Explorer giữ nguyên** | JOIN `progress`; chưa cần cột mới nếu dùng vị trí hiện tại | Test: thứ tự đúng theo từng kiểu sắp; sách chưa đọc không lỗi | S | — (dùng cột `furthest_*` khi 22.1 xong) |
| 22.4 | Nhắc nghỉ mắt + "còn X phút trong chương" | Bộ đếm thời gian đọc chủ động (dùng lại ở 22.3). Thời gian còn lại = ký tự còn lại ÷ tốc độ (mặc định 900 ký tự/phút, chỉnh được); hiện ở status bar **chỉ khi extension Focus Timer bật** (mặc định tắt). Nhắc dạng toast của VS Code sau 30/60/90 phút hoặc tắt; tốc độ đọc và mốc nhắc chỉnh ở trang Focus Timer | Chỉ `char_count` đã có trong `chapters` | Kiểm tra bằng trình duyệt thật: đếm đúng khi tab ẩn/boss key; nhắc hiện một lần rồi im | S | — |
| 22.11 | Chủ đề màu | Bộ biến CSS thứ hai/ba: **Dark+** (mặc định), **Light+**, **Monokai**, thêm **AMOLED** (đen). Chọn ở trang **Color Themes** trong Extensions; màn `.panic` dùng cùng biến | `theme` là một khoá cài đặt (đồng bộ ở 22.1) | Playwright: từng theme không có chữ mất tương phản; **màn boss key đổi theo theme** | S | — |
| 22.1 | Đồng bộ highlight / cài đặt / vị trí lên server, gộp "chỉ tiến" | Bảng `highlights(book_id, chapter_idx, p, start, end, created_at)`, `settings(key, value, updated_at)`; thêm cột `furthest_idx`, `furthest_ratio`, `client_ts` vào `progress`. Server: `furthest` chỉ tăng (so cặp chương, tỉ lệ); vị trí hiện tại ghi khi `client_ts` mới hơn. Highlight: thay cả tập của một chương theo "mới hơn thắng". Trạng thái (lần đồng bộ cuối, hàng đợi, lỗi) hiện ở trang **Sync & Backup** và icon `sync` có sẵn ở status bar. Client: ghi ngay vào `localStorage`, đẩy lên nền, hàng đợi thử lại khi mất mạng; lần đầu đăng nhập thì nhập `localStorage` cũ lên (gộp, không ghi đè) | `GET/PUT /api/settings`; `GET /api/books/:id/highlights`; `PUT /api/books/:id/chapters/:idx/highlights`; `POST …/progress` nhận thêm `client_ts` (tương thích ngược) | Test hai "thiết bị" (hai cookie): ghi xen kẽ mà `furthest` không lùi; highlight tạo ở máy A hiện ở máy B; nhập `localStorage` cũ một lần và không nhân đôi; backup/restore mang theo cả highlight | M | — |
| 22.6 | Bookmark | Bảng `bookmarks(id, book_id, chapter_idx, p, note, created_at)`; trang **Bookmarks** trong Extensions (danh sách, ghi chú, xoá; chấm đánh dấu ở lề chỉ hiện khi extension bật, mặc định tắt); thêm bằng phím tắt chọn phím chưa dùng (`Ctrl+B`, `Ctrl+Shift+U`, `Alt+←/→`, `Ctrl+Alt+T` đã bị chiếm). Khớp với `bookmarks.json` của vBook để EPR-19/21 nối được | `GET/POST/DELETE /api/books/:id/bookmarks` | Thêm/xoá/nhảy tới đúng đoạn; đồng bộ sang thiết bị khác | S | 22.1 |
| 22.3 | Thống kê đọc + bản đồ nhiệt | Bảng `reading_hourly(day, hour, book_id, seconds, PRIMARY KEY(day, hour, book_id))`; client gửi gộp mỗi 60 giây. Trang **Activity Insights** trong Extensions (tab "Extension: Activity Insights" trong editor) vẽ lưới đóng góp kiểu GitHub, chuỗi ngày, giờ vàng, sách đọc nhiều nhất | `POST /api/stats/ping`; `GET /api/stats?from&to` | Test: cộng dồn đúng, chuỗi ngày qua nửa đêm; trình duyệt thật: lưới hiện đúng, không ghi khi tab ẩn | M | 22.4 (dùng chung bộ đếm) |
| 22.0 | **Bộ ghép EPUB dùng chung** (chương → EPUB trong bộ nhớ) | Một hàm trong `src/` không phụ thuộc runtime, có unit test; là nền cho 22.2, 22.8 và EPR-19/20 | — | Sinh EPUB mà `parseEpubMeta` đọc lại đúng số chương/tên chương | S | — (làm trong EPR-19 hoặc ngay trước 22.2) |
| 22.2 | Nhập TXT/HTML tự chia chương | Trình duyệt đọc file, tự đoán mã hoá (UTF-8 nghiêm ngặt, không được thì GB18030), chạy bộ luật **tự viết**: `Chương/Chuong/Hồi/Quyển/Phần + số/số La Mã/chữ`, `第…章/回/节`, `Chapter N`, cùng điều kiện dòng ngắn (≤ 60 ký tự), đứng riêng, có dòng trống trước. Hiện bản xem trước (số chương, chương ngắn/dài bất thường) rồi mới nhập; nếu không nhận ra thì chia theo độ dài. Ghép bằng 22.0 rồi đưa qua đường upload theo mảnh + ingest hiện có | Dùng `/api/uploads` sẵn có, không endpoint mới | Bộ test regex trên mẫu Việt/Trung/Anh và trường hợp lạ; nhập file TXT thật, ra đúng số chương | M | 22.0 |
| 22.8 | Xuất sách (EPUB/TXT) | `GET /api/books/:id/export?format=epub\|txt&from&to`, đọc tuần tự từ `content.bin`. Nút Export nằm trên trang **Library**. TXT gộp một file kèm mục lục; EPUB dựng bằng 22.0. **Tên file mặc định theo tên ngụy trang**, chỉ dùng tên thật khi `?real=1` | Không đổi DB | Xuất sách 2953 chương: mở lại được, số chương khớp; bộ nhớ không phình | S–M | 22.0 |
| 22.5 | Tìm kiếm trong sách / toàn thư viện | Bảng ảo FTS5 `chapter_fts(book_id, idx, text)` với `unicode61 remove_diacritics 2`, **đổi đ→d ở cả hai phía**; lập chỉ mục lúc ingest và có nút "lập chỉ mục lại" cho sách cũ (dùng đường reindex). UI là trang **Global Search** trong Extensions: ô nhập + kết quả dạng `tệp:dòng` kèm đoạn trích, bấm nhảy tới đoạn. Tìm cả trong bookmark | `GET /api/search?q&book&limit` | Test: bỏ dấu, chữ đ, cụm từ, sách đang index dở không lỗi; **đo dung lượng thêm** (dự kiến bằng cỡ văn bản, ~25 MB cho sách 2953 chương) và tốc độ trên sách lớn | L | — |
| 22.7 | Sao lưu lên WebDAV | `backup.mjs` thêm bước đẩy bản sao lưu tới một URL WebDAV (thông tin trong SealedSecret), giữ N bản, xoá bản cũ; **diễn tập khôi phục từ WebDAV** rồi mới tính xong. Đây là phương án (c) của EPR-05 | Biến môi trường mới, không đổi DB | Backup → xoá sạch → khôi phục từ WebDAV → mọi chương khớp từng byte | M | ⏳ Bạn cho biết máy chủ WebDAV nào (Nextcloud, Synology, dịch vụ khác) |

### 14.5 Lộ trình và cổng thoát

| Giai đoạn | Việc | Cổng thoát (phải đạt mới sang giai đoạn sau) |
|---|---|---|
| **A — nhỏ, thấy ngay** | 22.12 → 22.10, 22.9, 22.4, 22.11 | `npm test` xanh; Playwright: mở/đóng view Extensions không đổi hộp bao 5 vùng và mặc định giao diện giống hệt trước; tải trước không làm tăng lỗi, sắp xếp đúng, nhắc nghỉ đúng, mọi theme không vỡ và **boss key đổi theo theme** |
| **B — nền đồng bộ** | 22.1 → 22.6 | Bài test hai thiết bị đạt; nhập `localStorage` cũ đúng một lần; restore từ backup mang theo highlight |
| **C — dữ liệu mới** | 22.3, 22.0 → 22.2, 22.8 | Thống kê đúng qua nửa đêm; nhập TXT thật và xuất lại, số chương khớp |
| **D — nặng / cần bạn** | 22.5, 22.7 | Đo dung lượng và tốc độ tìm kiếm trên sách lớn; diễn tập khôi phục từ WebDAV |

Phụ thuộc: 22.9, 22.4, 22.11, 22.6, 22.3, 22.5, 22.8 đều cần khung 22.12 (giao diện của chúng nằm trong đó); 22.6 cần 22.1; 22.3 dùng bộ đếm của 22.4; 22.2 và 22.8 cần 22.0. Nếu EPR-19 làm trước thì 22.0 nằm trong đó.

### 14.6 Chỉ số nghiệm thu chung

- Số test tăng theo từng việc; typecheck (Worker + server + tests) vẫn xanh.
- Thời gian mở chương và mở sách **không tệ đi** so với trước khi làm (đo trước ở giai đoạn A).
- Dung lượng dữ liệu tăng có kiểm soát: FTS5 (22.5) là thứ duy nhất tăng đáng kể, đo trước khi bật cho toàn thư viện.
- Sau mỗi giai đoạn, kiểm tra tay một lượt các màn hình chính bằng trình duyệt thật ở cả chế độ ngụy trang và chế độ boss key.

### 14.7 Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Đồng bộ ghi đè dữ liệu cũ khi nhập `localStorage` lần đầu | Nhập theo kiểu **gộp** (highlight lấy hợp, cài đặt "mới hơn thắng"), có test; giữ bản `localStorage` cũ đến khi xác nhận |
| Đổi theme làm lộ màn boss key hoặc chữ khó đọc | Cổng thoát A kiểm tra riêng; boss key dùng cùng biến màu |
| Đo thời gian đọc thành "nhật ký hoạt động" đáng ngại | Chỉ lưu số giây theo (ngày, giờ, sách), không lưu nội dung; panel nằm sau đăng nhập, dùng icon vốn có |
| Migration sai trên dữ liệu thật | Chỉ thêm cột/bảng; đã có backup hằng đêm và runbook khôi phục; thử migration trên bản restore trước |
| FTS5 làm đầy đĩa hoặc chậm khi ingest | Đo trước; lập chỉ mục sau khi ingest xong (không chặn upload); cho tắt theo từng sách |
| Regex nhận sai chương ở file TXT lạ | Luôn có bản xem trước, chia theo độ dài làm phương án dự phòng |

### 14.8 Ràng buộc: mọi giao diện phụ trợ nằm trong view Extensions

**Yêu cầu (2026-09-21, sau khi xem ảnh chụp app đang chạy):** Explorer, tab, editor và status bar **giữ nguyên như hiện tại**; giao diện của mọi tính năng thêm vào được dồn hết vào view **Extensions** (icon ghép hình ở activity bar), đúng cách VS Code thật đặt tiện ích.

Layout hiện có 5 vùng cố định: thanh tiêu đề, activity bar (48 px), sidebar (240 px, tối thiểu 170 px), nhóm editor (tab + breadcrumb + nội dung + minimap 70 px) và status bar. Chưa có panel phía dưới, chưa có `@media` nào (chưa hỗ trợ màn hình điện thoại). **Không việc nào ở mục 14 được đổi kích thước hay vị trí của 5 vùng này.**

**Cách hoạt động (EPR-22.12):**
- Bấm icon Extensions → sidebar đổi sang view "EXTENSIONS" (cùng vùng 240 px): ô lọc, mục "INSTALLED" liệt kê các extension nội bộ, mỗi cái có biểu tượng, tên, phiên bản, mô tả một dòng, nhà phát hành "devdocs" và bánh răng Disable/Enable.
- Bấm một extension → mở tab "Extension: <tên>" trong editor (giống trang chi tiết extension của VS Code); giao diện của tính năng nằm trong tab đó. Lưới thống kê 53 tuần không vừa sidebar 240 px nhưng vừa tab này.
- Tab loại mới `ext:<id>`, lưu trong session như tab sách. Hệ tab hiện gắn với (sách, chương) nên đây là chỗ đụng vào code, không phải layout.
- Trạng thái bật/tắt lưu trong cài đặt; cũng là công tắc tắt nhanh một tính năng nếu nó lỗi.

| Extension | Việc | Giao diện nằm ở | Mặc định |
|---|---|---|---|
| **Library** | 22.9 sắp xếp + %, 22.8 xuất sách | Trang riêng (danh sách sách, sắp xếp, %, nút Export); **Explorer không đổi** | Bật |
| **Bookmarks** | 22.6 | Trang riêng; chấm đánh dấu ở lề chỉ hiện khi bật | Tắt |
| **Activity Insights** | 22.3 | Trang riêng (lưới nhiệt, chuỗi ngày, giờ vàng) | Bật |
| **Focus Timer** | 22.4 | Trang chỉnh; khi bật mới thêm mục ở status bar và toast nhắc nghỉ | Tắt |
| **Color Themes** | 22.11 | Trang chọn theme | Bật (Dark+ chính là giao diện hiện tại) |
| **Global Search** | 22.5 | Trang riêng (ô nhập + kết quả) | Bật |
| **Sync & Backup** | 22.1, 22.7 | Trang trạng thái; icon `sync` có sẵn ở status bar | Bật |

Không có giao diện: 22.10 (tải trước chương). 22.2 (nhập TXT) dùng lại hộp thoại Import có sẵn (nới `accept`, thêm bản xem trước) vì đó là cách thêm sách chứ không phải giao diện phụ trợ.

**Quy tắc mặc định:** extension nào chỉ hiện bên trong view Extensions thì bật sẵn; extension thêm thứ ra ngoài view (status bar, lề, toast) thì **mặc định tắt**. Vì vậy ở trạng thái mặc định, mọi thứ ngoài view Extensions **giống hệt hiện tại**.

**Các icon còn lại:** Search, Source Control và Run hiện là trang trí. Khi Extensions chạy thật, để cả bốn phản ứng như VS Code thật: bấm vào thì hiện view rỗng ("No results", "The folder currently open doesn't have a git repository", "No debug configurations"). Việc nhỏ này nằm trong 22.12.

**Boss key và chồng lớp:** view Extensions và tab extension nằm trong `#app` nên bị màn boss key (`z-index` 100) che như mọi thứ khác. Toast của Focus Timer phải có `z-index` thấp hơn 100 và bị ẩn hẳn khi đang boss key. Màn boss key đổi theo theme (22.11).

**Phím tắt:** chỉ dùng tổ hợp có phím bổ trợ; **không dùng phím chữ trơn**, vì W/S/A/D đang để cuộn/chuyển chương và chuỗi mở khoá boss key nhận phím chữ.

**Cổng kiểm tra bắt buộc cho mọi giai đoạn:** trước khi làm, Playwright đo hộp bao (bounding box) của 5 vùng ở 3 cỡ cửa sổ (1920×1080, 1366×768, 1024×700) ở trạng thái mặc định và lưu lại; sau mỗi giai đoạn đo lại và so khớp kích thước/vị trí (nội dung trong vùng được đổi, khung vùng thì không), kèm ảnh chụp ở chế độ thường và chế độ boss key để xem bằng mắt. Riêng ngoài view Extensions ở trạng thái mặc định, ảnh chụp phải **trùng ảnh trước khi làm**.

### 14.9 Cập nhật 2026-09-21: khung đọc chuyển sang Monaco (nhánh `feat/monaco-reader`, chưa gộp vào `main`)

Theo yêu cầu, vùng đọc giờ là **Monaco** (lõi editor của VS Code, MIT) thay cho các dòng HTML tự vẽ.

**Đính chính hai chỗ trong kế hoạch trước:**
- App **đã dùng bộ icon thật `@vscode/codicons`** (751 icon, font nhúng sẵn, commit `5dc0103`); câu "app dùng icon riêng" là sai, nên không có gì để đổi.
- **Tải trước chương kế đã có sẵn** (`prefetchAround` nạp chương ±1 khi mở chương), nên EPR-22.10 chỉ còn là chỉnh nhỏ (bộ đệm, bỏ qua khi tab ẩn/boss key), không phải làm mới.

**Đã làm và kiểm chứng (Playwright, server thật, CSP nghiêm):**
- Bundle riêng chỉ gồm lõi editor + ô Find + Go to line, **không có gói ngôn ngữ** (bản `min` đầy đủ nặng hơn 10 MB): `public/vendor/monaco/` gồm `monaco.js` 2,7 MB (gzip ~0,7 MB), `monaco.css` 94 KB, `editor.worker.js` 297 KB. Build bằng `npm run build:monaco` (esbuild, script ở `client/build-monaco.mjs`); thư mục đầu ra **không commit**, được dựng trong Dockerfile và trong `deploy.yml` (đường Cloudflare cũ).
- Tải lười ở lần mở chương đầu, và làm nóng sau khi đăng nhập lúc rảnh.
- Mỗi đoạn văn = một dòng của model + một dòng trống, nên highlight vẫn lưu theo `(đoạn, bắt đầu, kết thúc)` như cũ, dữ liệu `localStorage` cũ vẫn dùng được.
- Có thật: số dòng, **minimap thật**, `Ctrl+F` (ô Find của editor), chọn chữ; lời thoại tô màu, tiêu đề, comment ngụy trang; đoạn đang đọc sáng, đoạn khác mờ; chế độ camo (`// `); serif; cỡ chữ; độ rộng dòng (`wordWrapColumn`).
- 17/17 kiểm tra: render dưới CSP, gutter, minimap, Find, tạo/xoá highlight, focus, giữ `S` để cuộn, tiến độ lưu về server, `D`/`A` và phím mũi tên đổi chương **kể cả khi editor đang có tiêu điểm**, khôi phục vị trí sau khi tải lại, `Ctrl+=`, camo, boss key. Thử với sách thật 2953 chương: dấu tiếng Việt đúng, không có khung cảnh báo ký tự lạ, ~270 ms lần đầu mở chương, khoảng 70 ms mỗi lần chuyển chương. `npm test` 32/32 và typecheck vẫn xanh.
- Hộp bao 5 vùng (title 30 px, activity bar 48, sidebar 240, status 22) không đổi; minimap cũ 70 px do canvas tự vẽ được thay bằng minimap của Monaco.

**Điểm kỹ thuật cần nhớ:**
- Bộ xử lý phím nghe ở **giai đoạn capture** để thấy phím trước Monaco (Monaco chặn mũi tên khi có tiêu điểm); `isBare` coi ô nhập ẩn của Monaco (`.inputarea`) không phải ô văn bản. Thanh Find của Monaco vẫn là ô nhập nên gõ chữ trong đó không bị bắt làm phím tắt.
- Đổi dòng: mọi ký tự xuống dòng trong đoạn (kể cả U+2028/2029) bị đổi thành khoảng trắng để dòng model khớp 1-1 với đoạn.
- `unicodeHighlight` tắt hết, nếu không tiếng Việt/Trung bị vẽ khung "ký tự dễ nhầm".
- Khi khôi phục vị trí, nếu layout chưa xong thì chờ (tối đa 20 khung hình) thay vì "khôi phục về 0" rồi ghi đè tiến độ thật.

**Chưa kiểm chứng / còn lại:**
- Chưa dựng image Docker thật (máy dev không có Docker); mới chạy lại đúng các bước của stage build trong thư mục sạch (`npm ci --ignore-scripts` → `build:server` → `build:monaco`). CI sẽ là lần đầu chạy thật.
- Chưa thử trên tunnel thật: tải lần đầu ~0,7 MB nén.
- Màu theme của Monaco đọc từ biến CSS lúc khởi tạo; khi làm EPR-22.11 (đổi theme) phải gọi `defineTheme` + `setTheme` lại.
- Monaco chạy chỉ với đường Node/Docker và Worker (đã thêm bước build); các tính năng ở mục 14 (Extensions, bản đồ nhiệt…) chưa động tới.

### 14.10 Tiến độ thực hiện EPR-22 (cập nhật liên tục)

Làm trên nhánh `feat/extensions`, từng giai đoạn một commit. Bằng chứng nằm ở các bài kiểm tra trình duyệt trong `tests/ui/` (xem `tests/ui/README.md`) và test server trong `tests/`.

| Việc | Trạng thái | Ghi chú |
|---|---|---|
| **22.12** khung Extensions | ✅ | View Extensions (lọc, danh sách, bánh răng Enable/Disable), tab `Extension: <tên>` (lưu trong session), icon Search/Source Control/Run mở view rỗng như VS Code, bấm icon đang mở thì thu gọn sidebar. Layout mặc định không đổi (17 phần tử × 3 cỡ cửa sổ). |
| **22.9** Library | ✅ | Sắp xếp (đọc gần nhất / mới thêm / tên / tiến độ), % theo **điểm xa nhất**, mở sách đúng chỗ đang đọc. Explorer không đổi. |
| **22.4** Focus Timer | ✅ | Mặc định tắt; khi bật: mục "N min left" ở status bar + nhắc nghỉ dạng toast; toast ẩn khi boss key; tắt thì gỡ sạch. |
| **22.11** Color Themes | ✅ | Dark+, Light+, Monokai, AMOLED; đổi cả editor Monaco lẫn màn hình che; tắt extension thì về Dark+. |
| **22.10** tải trước chương | ✅ (đã có) | Chỉ thêm: không tải khi tab ẩn / đang boss key. |
| **22.1** đồng bộ | ✅ | Bảng `settings`, `highlights`; `progress` thêm `furthest_*` (chỉ tiến) và `client_ts` (vị trí hiện tại theo đồng hồ thiết bị mới nhất, đồng hồ lệch bị chặn ở +60 s). Client: cache ở `localStorage`, đẩy nền, hàng đợi thử lại; máy chưa từng đồng bộ thì **gộp** highlight cũ chứ không ghi đè. Mở chương cũng tính là tiến độ. |
| **22.6** Bookmarks | ✅ | Mặc định tắt; `Ctrl+Alt+K` đánh dấu đoạn đang đọc, thanh xanh cạnh số dòng, trang liệt kê, bấm để nhảy đúng đoạn, xoá. Lưu ở server nên máy nào cũng thấy. |
| Sync & Backup (trang) | ✅ | Trạng thái, lần đồng bộ cuối, việc chờ đẩy, "Sync now". |
| **22.3** Activity Insights | ✅ | Chỉ lưu thời lượng (ngày, giờ, sách), đếm khi cửa sổ đang dùng và không ở màn hình che; lưới đóng góp 53 tuần, chuỗi ngày (≥ 1 phút/ngày), giờ vàng, module đọc nhiều nhất. Mặc định bật. Tắt thì dừng ghi. |
| **22.0** bộ ghép EPUB | ✅ | `src/epubwrite.ts` (fflate, không phụ thuộc runtime): EPUB3 + NCX, `mimetype` đầu tiên không nén, escape XML, bỏ ký tự điều khiển; đọc lại được bằng `parseEpubMeta`. Dùng cho 22.2, 22.8 và sau này EPR-19/20. |
| **22.2** nhập TXT/HTML | ✅ | Đi qua **đường upload theo mảnh có sẵn**; server (`src/textsplit.ts`) giải mã UTF-8/GB18030, nhận chương Việt/Trung/Anh/đánh số (số La Mã chỉ tính khi viết hoa; danh sách 1,2,3 ngắn không bị coi là chương), cắt theo độ dài nếu không thấy tiêu đề. `complete?dry=1` cho **xem trước** (số chương, tên chương, cảnh báo) trước khi tạo sách; huỷ thì xoá upload. |
| **22.8** xuất sách | ✅ | `GET /api/books/:id/export?format=txt|epub&from&to&real=1`, dựng lại EPUB từ chương đã lưu (app không giữ file gốc). Tên file mặc định theo tên ngụy trang, `real=1` (hoặc khi đang hiện tên thật) mới dùng tên thật. Nút TXT/EPUB trên trang Library. |
| **22.5** tìm kiếm toàn văn | ✅ | SQLite FTS5 (`unicode61 remove_diacritics 2`; chữ **đ** được đổi thành d ở cả lúc lập chỉ mục lẫn lúc tìm); bảng FTS tạo lúc dùng lần đầu nên nếu engine thiếu FTS5 thì chỉ mất tìm kiếm chứ app vẫn khởi động (đã kiểm FTS5 trên Node 24.21 / SQLite 3.53.4). Lập chỉ mục theo mảnh `POST /api/books/:id/search-index`; sách mới tự lập chỉ mục nền; sách cũ bấm "Index now". Kết quả trỏ tới **đoạn** (block) và hiện đoạn trích với chữ gốc có dấu; bấm để nhảy tới đoạn. Reindex/xoá sách thì xoá chỉ mục. Nằm ở extension **Global Search**. |
| **22.7** sao lưu WebDAV | ✅ code + test, ⏳ cần Secret | `server/webdav.ts` + `backup.mjs`: đẩy `db/app-<giờ>.sqlite` và mirror `objects/` (chỉ file mới), giữ N bản, kiểm kích thước; **`restore-webdav`** kéo snapshot mới nhất còn nguyên (bỏ qua bản hỏng/dở dang) rồi khôi phục. Đã diễn tập khôi phục từ WebDAV (máy chủ WebDAV giả nghiêm ngặt) và chương khớp từng byte. Lỗi tải lên làm CronJob **đỏ** nhưng bản local vẫn có. Để bật: tạo Secret `epub-reader-offsite` (xem dưới). |

Kiểm chứng giai đoạn A–D: `npm test` 69/69; trình duyệt thật (`tests/ui/`): 17 (đọc) + 33 (Extensions) + 20 (hai thiết bị) + 10 (Insights) + 12 (nhập/xuất) + 13 (tìm kiếm) kiểm tra, không lỗi console, và layout mặc định không đổi ở 3 cỡ cửa sổ.

Khuyết điểm có từ trước được sửa trong lúc làm: (1) bật/tắt "hiện tên thật" không làm mới trang extension đang mở và xoá mất breadcrumb của nó; (2) mở một chương mà không cuộn thì vị trí "hiện tại" **không được lưu** (chỉ lưu khi có sự kiện cuộn), nên máy khác không biết bạn đã chuyển chương.

Hạn chế đã biết: đồng bộ cài đặt dùng "mới hơn thắng" theo **từng khoá**, nên `extensions` (danh sách bật/tắt) được thay cả khối; đồng hồ giữa các máy có thể lệch nhau vài giây. Highlight cũ chỉ được nhập lên server khi mở đúng cuốn sách đó lần đầu.

**Bật sao lưu WebDAV (22.7 / EPR-05 phương án c):** app không cần sửa gì thêm. Trong `ci-cd-platform`, tạo Secret cho CronJob (cụm này dùng Sealed Secrets, nên seal như `sealedsecret.yaml` hiện có), ví dụ:

```bash
kubectl -n epub-reader create secret generic epub-reader-offsite --dry-run=client -o yaml \
  --from-literal=BACKUP_WEBDAV_URL="https://<máy-chủ-webdav>/remote.php/dav/files/<user>" \
  --from-literal=BACKUP_WEBDAV_USER="<user>" --from-literal=BACKUP_WEBDAV_PASSWORD="<mật-khẩu-ứng-dụng>" \
  | kubeseal --format yaml > apps/epub-reader/offsite-sealedsecret.yaml
```

rồi thêm khối `envFrom` (đã có sẵn trong `deploy/k8s/cronjob-backup.yaml`, `secretRef` tuỳ chọn) vào `apps/epub-reader/cronjob-backup.yaml` của `ci-cd-platform`. Tuỳ chọn: `BACKUP_WEBDAV_DIR` (mặc định `epub-reader`), `BACKUP_WEBDAV_KEEP`. Khôi phục trên máy trống: `node backup.mjs restore-webdav` (cùng các biến môi trường, `DATA_DIR` và `BACKUP_DIR` trống). **Chưa thử trên máy chủ WebDAV thật nào**, chỉ trên máy chủ giả; lần đầu nên chạy tay một Job và thử khôi phục vào thư mục tạm. EPR-05 chưa tính là xong cho đến khi khôi phục thử từ bản off-site thành công trên cụm.
