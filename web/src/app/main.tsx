/** SPA entry (index.html): styles, query client, router. */
import '@lichess-org/chessground/assets/chessground.base.css';
import '../styles/lichess-theme.css';
import '../styles/components.css';
import '../styles/board.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { queryClient } from './api/queryClient.ts';
import { createRouter } from './router.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createRouter()} />
    </QueryClientProvider>
  </StrictMode>,
);
