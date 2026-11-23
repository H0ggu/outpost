// Profiles, search, databases, files and prep logic (owner: profiles; routes in
// routes/{search,profiles,databases,files,prep}.ts; helper folders src/{search,databases,files,prep}/).
//
// Cross-module API: access.ts — loadProfileForViewer (slug → visible source ids, 404 for private
// profiles of others; pgn sources only while their database is readable), loadProfileByIdForViewer
// and loadDatabaseForViewer. Stats, explorer and games use these.
// Also useful elsewhere: profileSummaries (ProfileSummary rows), currentRatings (per source and time
// class), visibleProfileSlugFor (src/search: "a visible profile with this account").
export {
  loadDatabaseForViewer,
  loadProfileByIdForViewer,
  loadProfileForViewer,
  type ViewableDatabase,
  type ViewableProfile,
} from './access.ts';
export { profileSummaries } from './service.ts';
export { currentRatings, sourceUrl } from './sources.ts';
