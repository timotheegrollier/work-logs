/**
 * Quitter un fichier du partage qui a un brouillon non envoyé : l'éditeur ouvert
 * pose ici sa question (Envoyer · Garder le brouillon ici · Annuler). Les gestes
 * qui changent le centre (entrée, autre fichier, Fermer) la demandent d'abord.
 * Fermer la fenêtre, lui, ne demande rien : le brouillon est gardé, le verrou rendu.
 */
type LeaveGuard = () => Promise<boolean>;

let guard: LeaveGuard | null = null;

export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** `true` : on peut quitter le fichier ouvert. */
export const requestLeave = (): Promise<boolean> => (guard ? guard() : Promise.resolve(true));
