// Définition des commandes slash (format API Discord brut).
const STR = 3; const INT = 4;
const PERIODS = [{ name: '24 heures', value: '24h' }, { name: '7 jours', value: '7d' }, { name: '30 jours', value: '30d' }, { name: 'Tout', value: 'all' }];
const coffre = (required = false) => ({ type: STR, name: 'coffre', description: 'Coffre', autocomplete: true, required });
const periode = { type: STR, name: 'periode', description: 'Période', choices: PERIODS };
const ADMIN = '32'; // Gérer le serveur

export const COMMANDS = [
  { name: 'stats', description: 'Statistiques d\'un coffre (ou de tous)', options: [coffre(), periode] },
  { name: 'joueur', description: 'Profil d\'un joueur : dépôts, retraits, items', options: [
    { type: STR, name: 'nom', description: 'Nom du joueur', required: true, autocomplete: true }, coffre(), periode] },
  { name: 'top', description: 'Classement des joueurs', options: [
    { type: STR, name: 'type', description: 'Classement', required: true, choices: [
      { name: 'Plus gros déposants', value: 'deposit' }, { name: 'Plus gros retraits', value: 'withdraw' },
      { name: 'Plus actifs', value: 'activity' }, { name: 'Bilan le plus négatif', value: 'net' }, { name: 'Items retirés', value: 'items_out' }] },
    coffre(), periode] },
  { name: 'classement', description: 'Classement par argent déposé (semaine du dimanche 19h au dimanche 19h)', options: [
    { type: INT, name: 'semaine', description: 'Quelle semaine', choices: [
      { name: 'Semaine en cours', value: 0 }, { name: 'Semaine dernière', value: 1 },
      { name: 'Il y a 2 semaines', value: 2 }, { name: 'Il y a 3 semaines', value: 3 }] }, coffre()] },
  { name: 'stock', description: 'Stock estimé d\'un coffre (entrées − sorties)', options: [coffre(true)] },
  { name: 'recent', description: 'Derniers mouvements', options: [coffre(),
    { type: STR, name: 'joueur', description: 'Filtrer par joueur', autocomplete: true },
    { type: INT, name: 'nombre', description: 'Nombre (max 25)', min_value: 1, max_value: 25 }] },
  { name: 'dashboard', description: 'Lien vers le tableau de bord' },
  { name: 'solde', description: 'Indique combien il y a VRAIMENT dans un coffre maintenant', default_member_permissions: ADMIN, options: [
    coffre(true),
    { type: INT, name: 'montant', description: 'Montant actuel dans le coffre, ex : 586737', required: true, min_value: 0 },
    { type: STR, name: 'type', description: 'Type d\'argent', choices: [{ name: 'Argent sale', value: 'black_money' }, { name: 'Argent propre', value: 'cash' }] }] },
  { name: 'nonreconnus', description: 'Logs que le bot n\'a pas compris', default_member_permissions: ADMIN },
];
