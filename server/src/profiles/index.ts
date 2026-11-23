// Profiles, search, databases, files and prep logic (owner: profiles; routes in
// routes/{search,profiles,databases,files,prep}.ts).
//
// Cross-module API: access.ts — loadProfileForViewer (slug → visible source ids, 404 for private
// profiles of others) and loadDatabaseForViewer. Stats, explorer and games use these.
export { loadDatabaseForViewer, loadProfileForViewer, type ViewableDatabase, type ViewableProfile } from './access.ts';
