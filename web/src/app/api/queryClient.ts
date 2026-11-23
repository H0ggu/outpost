import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client.ts';

/** Shared TanStack Query client: no retries on 4xx, modest staleness, no refetch on focus. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failures, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failures < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
