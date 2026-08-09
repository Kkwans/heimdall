# Design QA — 已删除 Key 统计与全局弹窗留白

- Source visuals:
  - `/home/Kkwans/.codex/attachments/73191ea9-003d-402f-a13d-79b5961313c7/codex-clipboard-bcb28a84-3d18-405e-b578-5911a0a6a08b.png`
  - `/home/Kkwans/.codex/attachments/6119b8b4-1da6-4d08-a037-7d9e9fe11eeb/codex-clipboard-9bc8b62a-f059-404e-afd9-33e69acf42b5.png`
- Implementation root: `/volume2/Project/Heimdall/.phase1-artifacts/stats-key-name-browser/stats-key-name-f366ba6/`
- Browser: TX5pro Chrome, Playwright headless, `zh-CN`, Asia/Shanghai.
- Target: isolated Dashboard `http://192.168.5.110:18889`, commit `f366ba6`.
- Viewports: desktop `1440 x 1000`; mobile `390 x 844`.
- Theme: light.

## Verified visual and data behavior

- Client Access Key names remain visible after deletion; a compact `已删除` tag follows the original name.
- Historical rows whose pre-fix name is irrecoverable use the stable `API Key #ID` label with `已删除`; records never associated with a Key use `未关联 API Key` without a deletion tag.
- Cost-table headers and data cells are uniformly left aligned.
- Average unit prices render with exactly two decimal places, for example `￥2.67/百万 Token`.
- Request-detail and provider-form modal headers use `24px` padding on all four sides.
- Modal body padding is `0 24px 24px`; title-left and close-right gaps are both `24px`.
- Title and close-button vertical center difference is at most `1px`.
- The same modal geometry passes at `390px`, without page-level horizontal overflow.

## Evidence

- `stats-cost-key-table-1440-light.jpg`: deleted name, deletion tag, left alignment, two-decimal average price.
- `stats-api-key-row-1440-light.jpg`: lower API Key statistics use the same name and deletion status.
- `request-detail-1440-light.jpg`: desktop request-detail modal spacing.
- `request-detail-390-light.jpg`: mobile request-detail modal spacing and scrolling.
- `admin-modal-1440-light.jpg`: reusable modal spacing applied to the provider form.
- `report.json`: 25/25 checks passed; zero console errors, page errors, HTTP errors, and failed browser requests.

## Data safety evidence

- Production database was inspected read-only and contained no orphaned Client Access Key groups.
- A consistent production copy migrated from schema v5 to v6 with `integrity=ok`, 1533 request rows unchanged, all 3 eligible Key groups resolved, and a second migration run applied no versions.
- The isolated database was backed up before migration. A real isolated create → priced request → delete flow returned the original name and `deleted=true` from both cost and API Key statistics.
- Production containers and database were not changed.

final result: passed
