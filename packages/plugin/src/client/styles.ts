/**
 * The page's stylesheet, rendered once by the page so unmounting removes it.
 * Classes carry the `hf-` prefix; colors and radii are DSH theme tokens, and
 * the layout follows Plugin Manager (960px column, 20px title, list rows that
 * reach 8px past the text on hover).
 * @module @kirkchinese/harness-forge/client
 */
export const CSS = `
.hf-page { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 0 clamp(24px, 4vw, 48px) 48px; color: var(--dsw-alias-label-primary); }
.hf-column { max-width: 960px; margin: 0 auto; }
.hf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 28px; flex-wrap: wrap; }
[data-platform='darwin'] .hf-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.hf-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.hf-subtitle { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.hf-actions { display: flex; align-items: center; gap: 8px; position: relative; }
.hf-tabs { display: inline-flex; gap: 2px; padding: 2px; margin: 20px 0 24px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover)); }
.hf-tab { height: 30px; padding: 0 14px; border: 0; border-radius: calc(var(--dsw-radius-md, 8px) - 2px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.hf-tab[aria-selected='true'] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l2); }
.hf-count { min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.hf-btn { height: 28px; padding: 0 12px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.hf-btn:disabled { opacity: 0.5; cursor: default; }
.hf-btn-primary { border-color: var(--dsw-alias-button-primary-fill); background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.hf-btn-danger { color: var(--dsw-alias-state-error-primary); }
.hf-btn-link { border: 0; background: transparent; padding: 0 4px; color: var(--dsw-alias-label-secondary); }
@media (hover: hover) {
  .hf-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .hf-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
  .hf-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
  .hf-btn-link:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: transparent; }
  .hf-tab:hover:not([aria-selected='true']) { color: var(--dsw-alias-label-primary); }
  .hf-row-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .hf-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.hf-btn:focus-visible, .hf-tab:focus-visible, .hf-switch:focus-visible, .hf-row-button:focus-visible, .hf-menu-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.hf-menu { position: absolute; top: 34px; right: 0; z-index: 5; min-width: 180px; padding: 4px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base)); border: 0.5px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
.hf-menu-item { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.hf-intro { display: flex; align-items: flex-start; gap: 12px; margin-top: 20px; padding: 12px 14px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.hf-intro p { margin: 0; flex: 1; }
.hf-section { margin-bottom: 32px; }
.hf-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.hf-section-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.hf-lead { margin: 0 0 16px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.hf-muted { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.hf-list { display: flex; flex-direction: column; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.hf-item { border-radius: var(--dsw-radius-xl, 12px); }
.hf-item[data-open='true'] { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover)); }
.hf-item-head { display: flex; align-items: center; gap: 12px; padding: 10px 8px; }
.hf-row-button { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 4px; margin: -4px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.hf-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hf-item-title { font-size: 14px; line-height: 20px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
.hf-item-desc { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-tag { flex: none; padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; font-weight: 400; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.hf-verdict { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; width: 132px; }
.hf-verdict-label { font-size: 12px; line-height: 16px; display: flex; align-items: center; gap: 6px; }
.hf-bar { display: flex; width: 100%; height: 4px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-interactive-bg-hover); }
.hf-bar > span { display: block; height: 100%; }
.hf-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
.hf-parts { padding: 0 8px 10px 34px; display: flex; flex-direction: column; gap: 2px; }
.hf-part { display: flex; align-items: flex-start; gap: 12px; padding: 7px 0; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.hf-part:first-child { border-top: 0; }
.hf-part-main { flex: 1; min-width: 0; font-size: 13px; line-height: 20px; }
.hf-part-name { font-weight: 500; overflow-wrap: anywhere; }
.hf-part-kind { color: var(--dsw-alias-label-tertiary); margin-right: 8px; font-size: 12px; }
.hf-part-state { flex: none; width: 130px; font-size: 12px; line-height: 20px; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.hf-reason { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.hf-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); }
.hf-switch { flex: none; position: relative; width: 32px; height: 18px; margin-top: 1px; border: 0; border-radius: 9px; padding: 0; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background 120ms; }
.hf-switch[aria-checked='true'] { background: var(--dsw-alias-state-business-primary); }
.hf-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 120ms; }
.hf-switch[aria-checked='true']::after { transform: translateX(14px); }
.hf-switch:disabled { opacity: 0.5; cursor: default; }
.hf-input, .hf-select, .hf-textarea { box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: 13px; }
.hf-input { flex: 1 1 280px; min-width: 200px; }
.hf-textarea { width: 100%; height: auto; min-height: 132px; padding: 8px 10px; resize: vertical; line-height: 20px; }
@media (pointer: coarse) { .hf-input, .hf-select, .hf-textarea { font-size: 16px; } }
.hf-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hf-card { font-size: 13px; line-height: 20px; padding: 14px 16px; border-radius: var(--dsw-radius-xl, 12px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); border: 0.5px solid var(--dsw-alias-settings-card-stroke, transparent); }
.hf-notice { margin: 16px 0 0; padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; white-space: pre-wrap; background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); }
.hf-notice[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.hf-notice-warn { color: var(--dsw-alias-state-error-primary); }
.hf-notice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.hf-empty { padding: 20px 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.hf-facts { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; margin: 0; }
.hf-facts dt, .hf-facts dd { margin: 0; padding: 9px 0; border-top: 0.5px solid var(--dsw-alias-border-l3); font-size: 13px; line-height: 20px; }
.hf-facts dt { color: var(--dsw-alias-label-secondary); }
.hf-facts dd { overflow-wrap: anywhere; }
.hf-brief { max-height: 320px; overflow: auto; margin: 10px 0; padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; line-height: 18px; white-space: pre-wrap; }
.hf-details summary { cursor: pointer; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.hf-back { margin: 20px 0 4px -4px; }
`
