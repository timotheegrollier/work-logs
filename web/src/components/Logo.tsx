/**
 * Logo inline (même motif que `desktop/icon.svg` : page crème à marque-page
 * ambre sur fond bleu). Inline plutôt qu'asset pour rester identique en dev,
 * en build web et dans l'application desktop empaquetée, sans tuyauterie.
 */
export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 512 512" role="img" aria-label="Logo WorkLogs" aria-hidden="false">
      <rect width="512" height="512" rx="116" fill="#1d3a9e" />
      <rect x="148" y="88" width="216" height="336" rx="20" fill="#f7f4ea" />
      <rect x="166" y="88" width="8" height="336" fill="#f2b13d" />
      <polygon points="238,88 278,88 278,176 258,158 238,176" fill="#f2b13d" />
      <rect x="206" y="210" width="118" height="24" rx="12" fill="#1d3280" />
      <rect x="206" y="266" width="118" height="24" rx="12" fill="#1d3280" />
      <rect x="206" y="322" width="72" height="24" rx="12" fill="#8fa0d8" />
    </svg>
  );
}
