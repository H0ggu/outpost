import { useEffect, useRef, useState } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { isChunkLoadError, reloadForNewVersion } from './chunkErrors.ts';
import { Box, Button, ErrorBox, licon, Page, Spinner } from './components/index.ts';
import { paths } from './paths.ts';

/**
 * Router error boundary: 404s from the router and errors thrown while loading or rendering a
 * route. A page whose code can't be fetched (a tab left open across an upgrade: the old chunks
 * are gone) reloads once to get the current version, and otherwise offers the reload.
 */
export default function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const chunk = !notFound && isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);
  const tried = useRef(false);

  useEffect(() => {
    if (!chunk || tried.current) return;
    tried.current = true;
    setReloading(reloadForNewVersion());
  }, [chunk]);

  if (chunk) {
    return (
      <Page title="Outpost was updated">
        <Box title="Outpost was updated">
          {reloading ? (
            <Spinner center label="Loading the new version" />
          ) : (
            <>
              <p>
                This page could not be loaded. Outpost was probably updated since this tab was opened, or the connection to
                the server dropped. Reloading gets the current version.
              </p>
              <Button icon={licon.Reload} onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </>
          )}
        </Box>
      </Page>
    );
  }

  return (
    <Page title={notFound ? 'Not found' : 'Error'}>
      <Box title={notFound ? 'Page not found' : 'Something went wrong'}>
        {notFound ? (
          <p>
            Nothing here. <Link to={paths.home}>Back home</Link>
          </p>
        ) : (
          <ErrorBox
            error={isRouteErrorResponse(error) ? new Error(`${error.status} ${error.statusText}`) : error}
            onRetry={() => window.location.reload()}
          />
        )}
      </Box>
    </Page>
  );
}
