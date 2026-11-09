// Commandes slash Discord → https://nls-coffres.pages.dev/interactions (signature vérifiée)
import { handleInteraction } from '../worker/index.js';

export const onRequestPost = ({ request, env }) => handleInteraction(request, env);
