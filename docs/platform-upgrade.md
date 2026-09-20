# Kế hoạch nâng cấp nền tảng — EPUB Reader

> Ngày: 2026-09-20 · Trạng thái: **10/16 mục backlog đã xong và có test; 3 mục cần chủ hệ thống (mục 9); 3 mục chưa làm (EPR-14, 15, 16).**
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
3. **Chặn truy cập: passcode + giới hạn thử (đã làm) + Cloudflare Access (khuyến nghị, cần chủ hệ thống).** Passcode một mình không đủ cho trang công khai.
4. **Backup: cùng node là mức tối thiểu, off-site là bắt buộc thật sự.** Backup hiện tại chống được hỏng dữ liệu/xoá nhầm/nâng cấp lỗi nhưng **không** chống được mất đĩa hoặc node.

## 4. Nguyên tắc

- Không thêm tính năng mới trước khi đóng P0.
- Không coi "pod Running" hay "HTTP 200" là bằng chứng hệ thống tốt: backup chỉ được tính khi **đã khôi phục thử thành công**.
- Không xoá dữ liệu người dùng trong tác vụ nền nếu chưa chứng minh được nó là rác (xem `ever_completed`).
- Mọi lỗi đã gặp phải có test tái hiện; mọi test phải từng thấy nó đỏ (đã làm mutation check cho khoá ingest, dọn rác, chặn đọc khi đang index).

## 5. Backlog

Trạng thái: ✅ xong + có test · ⏳ cần chủ hệ thống · 🔲 chưa làm. Effort: S 1–2 giờ, M nửa ngày, L nhiều ngày.

| ID | Ưu tiên | Việc | Effort | TT | Điều kiện hoàn thành |
|---|---|---|---|---|---|
| EPR-01 | P0 | Giới hạn thử đăng nhập: 5 lần/15 phút/client + trần toàn cục 60 | S | ✅ | Lần 6 → 429 kể cả đúng mật khẩu; client khác không bị ảnh hưởng; trần toàn cục chặn được địa chỉ giả |
| EPR-02 | P0 | Cloudflare Access trước `vs.dophamnguyen.xyz` | S | ⏳ | Trang đăng nhập không tải được khi chưa qua Access |
| EPR-03 | P0 | Commit SealedSecret vào git | S | ✅ | `apps/epub-reader/sealedsecret.yaml` có trong `ci-cd-platform` (commit `4b74170`) |
| EPR-04 | P1 | CronJob backup hằng đêm (snapshot SQLite `VACUUM INTO` + mirror `objects/`, giữ 14 bản) | M | ✅ | **Diễn tập khôi phục tự động**: backup → xoá sạch dữ liệu → restore → mọi chương khớp từng byte. **Đã chạy trên volume thật của cụm (2026-09-20):** backup 3 file/38 MB; khôi phục vào thư mục tạm: `integrity_check` ok, 1 sách/2389 chương/3 file, 4 giây |
| EPR-05 | P1 | Backup **off-site** | M | ⏳ | Bản sao nằm ngoài node/đĩa đang chạy app và đã khôi phục thử từ đó |
| EPR-06 | P1 | Test + cổng CI: typecheck + 25 test; đỏ thì không đẩy image | M | ✅ | PR/push chạy `npm test`; job build phụ thuộc job test |
| EPR-07 | P1 | Tự ghim tag `:<sha>` vào manifest để cụm tự cập nhật | S | ⏳ | Cần secret `CI_CD_PLATFORM_TOKEN`; xanh → commit vào `ci-cd-platform` → ArgoCD rollout |
| EPR-08 | P1 | Khoá ingest theo từng sách (409 khi trùng) | S | ✅ | 4 request song song → có 409, dữ liệu vẫn đúng từng byte |
| EPR-09 | P1 | Dọn upload dở sau 24 giờ, **không bao giờ** dọn sách đang reindex | M | ✅ | Test khởi động lại với ngưỡng 0: upload dở bị xoá cả file, sách đang reindex còn nguyên và hoàn tất được |
| EPR-10 | P1 | Chặn zip bomb (giới hạn dung lượng giải nén trước khi giải nén) | S | ✅ | Chương khai 40 MB → 422 "too large", server vẫn khoẻ, xoá được |
| EPR-11 | P2 | Header bảo mật (CSP chặt, X-Frame-Options, nosniff, Referrer-Policy, HSTS) + `no-store` cho API | S | ✅ | Trình duyệt thật: 0 vi phạm CSP, toàn bộ luồng UI chạy |
| EPR-12 | P2 | Thu hồi phiên ("Sign out everywhere", epoch trong token) | M | ✅ | Đăng xuất ở một thiết bị → mọi cookie cũ đều 401 |
| EPR-13 | P2 | `/healthz` kiểm tra DB thật + dung lượng đĩa; readiness dùng nó | S | ✅ | DB hỏng → 503 → pod ra khỏi Service |
| EPR-14 | P2 | Cảnh báo đĩa sắp đầy (~80 MB/sách lớn) | S | 🔲 | Log `LOW DISK` (đã có) được đẩy thành cảnh báo qua hệ thống alert hiện có |
| EPR-15 | P2 | Bỏ đường Cloudflare Worker (xem quyết định 1) | M | 🔲 | Ingest một request, xoá staging/multipart, `deploy.yml` |
| EPR-16 | P3 | Nhiều người dùng / tìm kiếm toàn văn | L | 🔲 | Chỉ làm khi quyết định 2 đổi |

Sửa kèm theo: ghi tiến độ đọc cho sách không tồn tại giờ trả 404; đọc chương khi sách đang index dở trả 409 (trước đó có thể trả sai nội dung vì offset mới trỏ vào file cũ); so sánh mật khẩu bằng HMAC nên không lộ độ dài.

## 6. Lộ trình và cổng thoát

| Giai đoạn | Nội dung | Cổng thoát (đo được) | TT |
|---|---|---|---|
| 0 – 72 giờ | EPR-01, 02, 03 | Gõ sai 5 lần → 429; trang đăng nhập không mở được khi chưa qua Access; secret có trong git | 2/3 (còn 02) |
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
| Test | 100% pass trước khi có image | 25/25, ~10 s |
| Vi phạm CSP | 0 | 0 |

Lưu ý: diễn tập trên cụm mới kiểm tra `integrity_check`, số sách/chương và số file trên bản khôi phục, chưa khởi động app trên dữ liệu đó. Việc so nội dung từng chương sau khôi phục được chứng minh bởi `tests/backup.test.ts` trên máy phát triển. Đo RTO thật cần chạy đủ runbook (ngừng app → khôi phục vào PVC dữ liệu → bật lại), lúc đó là dữ liệu thật của người dùng nên chỉ làm khi cần.

**Definition of Done cho một thay đổi:** có test tái hiện lỗi/tính năng; `npm run typecheck` và `npm test` xanh; nếu đụng migration thì dựng được DB mới từ đầu; nếu đụng luồng UI thì chạy thử trong trình duyệt thật, không chỉ `node --check`.

**Release gate:** PR → typecheck + test. `main` → thêm build arm64. Sau khi có `CI_CD_PLATFORM_TOKEN` → tự ghim tag. Việc còn thiếu là gate staging: hiện chưa có môi trường thử trên cụm.

## 8. Sổ rủi ro và điều kiện dừng mọi việc khác

| Rủi ro | Xác suất | Ảnh hưởng | Giảm thiểu / kế hoạch dự phòng |
|---|---|---|---|
| Mất đĩa/node `ubuntu-16gb` khi backup còn cùng node | Thấp | **Mất toàn bộ sách** | EPR-05. Giữ file `.epub` gốc ở máy cá nhân cho đến khi có off-site |
| Mất khoá giải mã Sealed Secrets (chưa backup, đã ghi trong ARCHITECTURE.md) | Thấp | Mất khả năng tạo lại secret | Lưu lại `ACCESS_PASSCODE`; secret tạo lại được trong vài phút |
| Trần đăng nhập toàn cục bị lợi dụng để khoá chủ | Trung bình | Chủ không đăng nhập được tối đa 15 phút | Chấp nhận (đã ghi trong code); khởi động lại pod xoá bộ đếm; Access giảm được nguồn tấn công |
| `node:sqlite` vẫn ở mức "experimental" trong Node 24 | Thấp | API đổi khi nâng Node | Ghim `node:24`; test chạy trên đúng phiên bản đó ở CI |
| Rollout dùng `Recreate` nên có vài giây gián đoạn | Chắc chắn | Thấp | Chấp nhận: SQLite chỉ có một tiến trình ghi |

**Stop-the-line:** (1) diễn tập khôi phục đỏ; (2) bất kỳ chương nào trả sai nội dung; (3) CI đỏ mà image vẫn được đẩy. Gặp một trong ba thì dừng mọi việc khác.

## 9. Việc cần chủ hệ thống làm

1. **EPR-02** — Cloudflare Zero Trust → Access → Applications → thêm `vs.dophamnguyen.xyz`, policy cho email của bạn.
2. **EPR-07** — tạo fine-grained PAT (Contents: read & write trên `Npham140201/ci-cd-platform`), lưu thành secret `CI_CD_PLATFORM_TOKEN` của repo EPUB Reader.
3. **EPR-05** — chọn nơi đặt bản sao off-site (ví dụ kéo `/backup` sang node khác qua Tailscale bằng `rsync`, hoặc đẩy lên một bucket) rồi tôi viết bước đó.

## 10. Runbook khôi phục

Điều kiện: có volume `epub-reader-backup` (hoặc bản sao off-site của nó).

1. Ngừng app: `kubectl scale deploy/epub-reader --replicas=0`.
2. Nếu volume dữ liệu còn nhưng hỏng: đổi tên/xoá PVC `epub-reader-data` rồi để ArgoCD tạo lại PVC rỗng. Công cụ **từ chối ghi đè** khi đã có `app.sqlite`.
3. Chạy Job một lần với cùng image và lệnh `node --disable-warning=ExperimentalWarning backup.mjs restore`, mount `epub-reader-data` vào `/data` và `epub-reader-backup` vào `/backup`.
4. Bật lại: `kubectl scale deploy/epub-reader --replicas=1`, đăng nhập, kiểm tra danh sách sách và mở vài chương.
5. Sách nào đang nạp dở lúc backup sẽ tự được tiếp tục khi mở (hoặc bị dọn sau 24 giờ nếu chưa từng nạp xong).

Toàn bộ quy trình này chạy tự động trong `tests/backup.test.ts` (backup → xoá sạch → restore → so từng chương), nên nếu test xanh thì công cụ khôi phục dùng được; phần chưa được kiểm chứng là chạy trên volume thật của cụm.
