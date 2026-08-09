# Design QA — 请求详情间距、缓存 Token 与列表 Tooltip

- Source visual truth: `/home/Kkwans/.codex/attachments/1f29e634-79ef-467c-954c-3966f13df059/codex-clipboard-d89b15c2-2808-4315-a943-56b02c02f347.png`
- Implementation: `/volume2/Project/Heimdall/.phase1-artifacts/cache-tooltip-browser/cache-tooltip-r1/request-detail-cache-1440.jpg`
- Full comparison: `/volume2/Project/Heimdall/.phase1-artifacts/cache-tooltip-browser/cache-tooltip-r1/reference-vs-implementation.jpg`
- Additional evidence: `requests-tooltip-1440.jpg`, `admin-modal-spacing-1440.jpg`, `request-detail-cache-390.jpg`
- Source pixels: `2222 x 1403`; source CSS viewport and density are unknown.
- Implementation pixels: `1440 x 1010`; CSS viewport `1440 x 1000`; device scale factor `1`.
- State: light theme; Requests list, request detail modal, provider form modal; desktop and `390 x 844` mobile.
- Normalization: the source and implementation were scaled to a common width for the combined visual comparison. Because the source viewport metadata is unavailable and the fixture data differs, exact whole-page pixel comparison is not asserted; the annotated modal spacing and truncation surfaces were compared directly and verified with browser geometry.

## Fidelity surfaces

- Fonts and typography: existing Heimdall font stack, sizes, weights and hierarchy are unchanged. Long model/provider text remains in the existing tag style and truncates without changing row height.
- Spacing and layout rhythm: title header padding is `16px` on all four sides; title-left and close-right gaps are both `16px`; title and close centers differ by less than `0.01px`. Body padding is `0 16px 16px` and no Ant Design container padding remains. The same measurements passed for request detail, provider form and mobile request detail.
- Colors and tokens: existing semantic tag, text, border and status colors are unchanged.
- Image quality and assets: this change introduces no image or icon assets; existing Ant Design icons remain unchanged.
- Copy and content: the Token help text explains the OpenAI/Anthropic cache-field difference, the unified input total, missing/zero values and the absence of output-cache fields. Product copy remains Chinese except protocol names.

## Comparison history

1. Initial browser pass found that the existing `MobileTooltip` passed function components directly to Ant Design, so no desktop tooltip was rendered. Fixed by using a layout-neutral native `inline-flex` trigger.
2. Final TX5pro Chrome pass confirmed full model and provider tooltip values, `16px` modal geometry, cache read `600`, cache write `200`, input total `1,000`, total `1,100`, and zero console/page/network errors.

## Findings

- No actionable P0, P1 or P2 visual mismatch remains within the requested scope.
- The Token help tooltip is intentionally allowed to wrap so the protocol distinction stays readable instead of producing an excessively wide overlay.

## Primary interactions tested

- Hover model and provider tags to reveal complete desktop tooltips.
- Open/close request detail and provider form modals.
- Hover the Token statistics help affordance.
- Open and scroll the request detail modal at `390px` width.

final result: passed
