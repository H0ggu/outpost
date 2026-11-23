/**
 * Outpost UI kit: small components in lila's visual language. Styles live in
 * src/styles/components.css (kit) and src/styles/board.css (boards).
 *
 * Heavy components are deliberately NOT re-exported here, so pages that don't use them don't
 * pull them into their chunk — import them directly:
 *   import { Board } from '../components/Board.tsx';        // chessground
 *   import { PgnViewer } from '../components/PgnViewer.tsx'; // pgn-viewer + its CSS
 */
export { Box, Card, type BoxProps } from './Box.tsx';
export { Button, ButtonLink, type ButtonVariant } from './Button.tsx';
export { EmptyState, ErrorBox, errorMessage, Spinner } from './Feedback.tsx';
export { countryName, FlagEmoji, flagEmoji } from './FlagEmoji.tsx';
export { Icon, licon, type LiconValue } from './Icon.tsx';
export { Page, StubPage, useDocumentTitle } from './Page.tsx';
export { Table, type Column, type TableProps } from './Table.tsx';
export { Tabs, type TabItem } from './Tabs.tsx';
export { TIME_CLASS_ICONS, TIME_CLASS_LABELS, TimeClassIcon } from './TimeClassIcon.tsx';
export { WdlBar, wdlSegments, type WdlBarProps, type WdlSegment } from './WdlBar.tsx';
