import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Box, ErrorBox, Page } from './components/index.ts';
import { paths } from './paths.ts';

/** Router error boundary: 404s from the router and errors thrown while rendering a route. */
export default function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Page title={notFound ? 'Not found' : 'Error'}>
      <Box title={notFound ? 'Page not found' : 'Something went wrong'}>
        {notFound ? (
          <p>
            Nothing here. <Link to={paths.home}>Back home</Link>
          </p>
        ) : (
          <ErrorBox error={isRouteErrorResponse(error) ? new Error(`${error.status} ${error.statusText}`) : error} />
        )}
      </Box>
    </Page>
  );
}
