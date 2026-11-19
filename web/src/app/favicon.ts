const ICON = 'favicon.svg';

let base: Promise<string> | undefined;
let latest = 0;

/** The badge draws over the static icon, so the icon itself stays the single source of its look. */
function badged(svg: string, count: number): string {
  const label =
    count < 10
      ? `<text x="11" y="5.4" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="8" font-weight="700" fill="#fff">${count}</text>`
      : '';
  return svg.replace('</svg>', `<circle cx="11" cy="5" r="5" fill="#d1242f"/>${label}</svg>`);
}

/** Shows the number of PRs that need me as a red badge on the tab icon; ten and more show a badge without a number. */
export async function setFaviconBadge(count: number) {
  latest = count;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  let href = ICON;
  if (count) {
    base ??= fetch(ICON).then((r) => r.text());
    try {
      href = `data:image/svg+xml,${encodeURIComponent(badged(await base, count))}`;
    } catch {
      // icon unavailable; the tab keeps the plain icon and the next call tries again
      base = undefined;
    }
  }
  // A newer count may have arrived while the icon loaded.
  if (count === latest) link.href = href;
}
