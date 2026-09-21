# Kế hoạch nâng cấp nền tảng — EPUB Reader

> Ngày: 2026-09-20 · Trạng thái: **12/22 mục backlog đã xong và có test; 3 mục cần chủ hệ thống (mục 9); 7 mục chưa làm (EPR-14, 15, 16, 19–22).** Sự cố upload ngày 2026-09-20 ở mục 12; kế hoạch tương thích với app vBook trên điện thoại ở mục 13.
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
| EPR-16 | P3 | Nhiều người dùng / tìm kiếm toàn văn | L | 🔲 | Chỉ làm khi quyết định 2 đổi |
| EPR-17 | P1 | Tải lên theo mảnh 256 KB (thử lại từng mảnh, song song 3, có tiến độ, `complete` lặp lại an toàn) + báo rõ khi upload bị cắt | M | ✅ | File 22 MB qua trình duyệt thật, cố ý làm hỏng 4 mảnh (đứt kết nối ×2, 504, 429): vẫn ra đủ 2953 chương và đúng một cuốn sách; 6 test tích hợp |
| EPR-18 | P1 | Phát hiện EPUB bị cụt (tải dở) **ngay trong trình duyệt** trước khi gửi byte nào, và server báo "cut off" thay vì `invalid zip data` | S | ✅ | File 22 MB thật: bản đủ qua, bản cắt còn 20 MiB bị chặn; 1 test tích hợp mới (32/32 xanh); đã chạy trên cụm (`b6b632d`) |
| EPR-19 | P2 | **Nhập bản sao lưu vBook** (`.tar.zst`) qua web: sách có nội dung + tiến độ đọc (mục 13) | L | 🔲 | Nhập đúng file mẫu 14 sách/7 sách có chương; sách đã có không bị tạo trùng; tiến độ khớp; test bằng bản sao lưu giả nhỏ |
| EPR-20 | P2 | **WebDAV chỉ đọc** để vBook duyệt và nhập sách từ EPUB reader (mục 13) | M | 🔲 | vBook trên điện thoại thấy danh sách và nhập được một cuốn; sai mật khẩu / thử quá nhiều lần bị chặn |
| EPR-21 | P3 | Đưa **tiến độ đọc về vBook** bằng một bản sao lưu nhỏ mà vBook khôi phục ở chế độ gộp (mục 13) | M | 🔲 | Thử trên **bản sao/dữ liệu thử** trước; chỉ tính xong khi vBook trên điện thoại hiện đúng chương đã đọc mà không mất dữ liệu khác |
| EPR-22 | P3 | Tính năng nên học từ vBook (mục 13.6): tải trước chương, sắp xếp kệ + %, nhắc nghỉ mắt, chủ đề màu, đồng bộ highlight/cài đặt lên server, biểu đồ hoạt động đọc, bookmark, nhập TXT chia chương, xuất sách | M–L | 🔲 | Chia 4 cụm, mỗi cụm có test riêng |

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

## 11. Việc còn lại — đã ghi, chưa làm (tạm hoãn theo yêu cầu 2026-09-20)

Thứ tự đề xuất khi quay lại: EPR-02 → 05 → 07 → 14 → 15. EPR-16 chỉ khi quyết định 2 đổi. Nhóm tương thích vBook (mục 13) làm theo thứ tự EPR-19 → 20 → 21; EPR-22 độc lập.

| ID | Ai làm | Cần gì để bắt đầu | Việc cụ thể |
|---|---|---|---|
| EPR-02 | Chủ hệ thống | Không cần gì thêm | Zero Trust → Access → Applications → thêm `vs.dophamnguyen.xyz`, policy cho email của bạn. Xong thì kiểm tra `curl -I https://vs.dophamnguyen.xyz/` bị chuyển tới trang đăng nhập Access |
| EPR-05 | Cả hai | **Chọn nơi đặt bản sao**: (a) `rsync` `/backup` sang node khác qua Tailscale (rẻ nhất, dùng hạ tầng có sẵn, cần đường SSH/khoá giữa hai node), hoặc (b) bucket (R2 / Oracle Object Storage, cần khoá truy cập) | Viết bước sao chép ra ngoài node vào CronJob; sau đó **diễn tập khôi phục từ bản sao off-site** (chưa khôi phục thử được thì chưa tính là xong) |
| EPR-07 | Chủ hệ thống | Tạo PAT fine-grained: Contents read & write trên `Npham140201/ci-cd-platform` | Lưu thành secret `CI_CD_PLATFORM_TOKEN` của repo EPUB Reader; job `pin-image` đã viết sẵn sẽ tự chạy. Kiểm tra: push một commit → xuất hiện commit "epub-reader: image ..." trong `ci-cd-platform` |
| EPR-14 | Tôi | **Chọn hệ thống cảnh báo** (Beszel / eBOSS_LOG / Zalo). App đã ghi log `LOW DISK` khi dưới 10% và `/healthz` trả `disk.free_pct`; đĩa của PVC là đĩa của node, và Beszel đã theo dõi đĩa host nên có thể chỉ cần đặt ngưỡng ở đó | Nối log/số liệu vào cảnh báo, thử bằng cách hạ ngưỡng tạm để thấy cảnh báo bắn |
| EPR-15 | Tôi | **Chốt quyết định 1**: không quay lại Cloudflare. Nên đợi vài tuần chạy ổn trên k3s rồi mới bỏ vì không quay lại được | Ingest một request; xoá staging/multipart trong `src/index.ts`; xoá `deploy.yml`, `scripts/upload-book.ts`, `wrangler.jsonc` và phụ thuộc `wrangler`; giữ test xanh |
| EPR-16 | Tôi | Chỉ khi bạn muốn nhiều người dùng hoặc tìm kiếm toàn văn | Thêm `user_id` vào `books`/`progress` từ đầu, không vá |
| EPR-19 | Tôi | **Hai câu trả lời** ở mục 13.5 (sách đã có thì giữ hay tạo mới; điện thoại có Tailscale không). Có sẵn file mẫu để thử | Nút "Nhập bản sao lưu vBook" dùng đường upload theo mảnh; giải nén zstd theo luồng; ghép EPUB trong bộ nhớ rồi đưa qua đường nhập sách hiện có |
| EPR-20 | Cả hai | Quyết định có mở WebDAV ra ngoài không (mục 13.4) | PROPFIND/GET chỉ đọc, mật khẩu riêng, giới hạn thử sai; dựng EPUB khi vBook tải (app không giữ file EPUB gốc) |
| EPR-21 | Cả hai | Điện thoại để thử khôi phục; **làm sau EPR-19** | Sinh bản sao lưu tối thiểu; thử ở chế độ "Gộp" hoặc "Chỉ khôi phục phần thiếu" trên dữ liệu thử |
| EPR-22 | Tôi | Chọn cụm bắt đầu (mục 13.6) | Bắt đầu với cụm 1 (nhỏ, thấy ngay) |

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

### 13.6 Tính năng nên học từ vBook (EPR-22, đã đối chiếu với EPUB reader)

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
