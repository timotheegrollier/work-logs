const CONTROL_OR_QUOTE_RE = /[\x00-\x1f\x7f"\\]/g;
const NON_ASCII_RE = /[^\x20-\x7e]/g;
const EXTRA_ENCODE_RE = /['()]/g;
/**
 * En-tête Content-Disposition fournissant systématiquement `filename` (repli
 * ASCII) et `filename*` (UTF-8, RFC 6266). Le module `content-disposition`
 * utilisé par `res.download` omet `filename*` dès que le nom est représentable
 * en Latin-1 (cas courant des accents français) ; or Chromium/Electron ne
 * décodent alors correctement ce nom qu'avec un `referrer_charset` que les
 * téléchargements desktop ne fournissent pas (jshttp/content-disposition#27).
 */
export const attachmentHeader = (filename) => {
  const ascii = filename.replace(CONTROL_OR_QUOTE_RE, '_').replace(NON_ASCII_RE, '_');
  const utf8 = encodeURIComponent(filename).replace(EXTRA_ENCODE_RE, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + utf8;
};

/**
 * Même nom, mais affiché dans l'onglet au lieu d'être téléchargé : c'est ce qui
 * permet à l'aperçu intégré de lire PDF, images et texte sans sortir de WorkLogs.
 * Un téléchargement direct reste toujours possible via `/api/files/:stored`.
 */
export const inlineHeader = (filename) => `inline; ${attachmentHeader(filename).slice('attachment; '.length)}`;
