import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { RichSearch } from './rich-search';
import { GoogleBlock, GoogleFormatting, GoogleInline, PreserveGoogleObjects } from './google-content';

/**
 * Extensions de l'éditeur riche, dans l'ordre. C'est aussi le schéma de la
 * conversion Markdown → document (`rich-markdown.ts`) : une proposition de l'IA
 * ne donne que des nœuds que l'éditeur sait afficher et garder.
 */
export function richExtensions({ googleLinked = false, onBlocked = () => {} }: { googleLinked?: boolean; onBlocked?: () => void } = {}) {
  return [
    StarterKit.configure({ link: { openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
    TableKit.configure({ table: { resizable: true } }), Image.configure({ allowBase64: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyleKit.configure({ lineHeight: false }), Highlight.configure({ multicolor: true }), RichSearch,
    GoogleFormatting, GoogleInline, GoogleBlock, PreserveGoogleObjects.configure({ enabled: googleLinked, onBlocked }),
  ];
}
