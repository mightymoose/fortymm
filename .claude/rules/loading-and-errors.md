# Each component that loads data owns its loading and error states

A component that loads data reads it with `useSuspenseQuery`, inside its own
boundary. The boundary shows a skeleton while the data loads, and an inline
error with Try again if the request fails. One boundary wraps one loading
component. The component's file exports the boundary and the component
together, so a caller can't render one without the other.

The root route's error page stays as the safety net. It catches what no
component boundary catches, such as a render bug. A user should see a
component's own error first, and the root page only when nothing nearer
could handle the error.

The session is the one exception. Every authenticated page needs it, so it
must hold up the loading screen. `AuthenticatedLayout`'s `Suspense` waits
for it, and the root error page shows its failure. A component that reads
`sessionQuery` gets the data that the layout already loaded. It needs no
boundary of its own.

## Why

- A failed request breaks only the part of the page that needed it. The
  rest of the page keeps working, and the user can still leave.
- A page never goes blank. `useQuery` doesn't throw. A component that
  returns `null` until its data comes shows nothing forever if the request
  fails. `useSuspenseQuery` throws the failure to the boundary.
- A skeleton in the shape of the content tells the user what is coming, and
  the layout doesn't jump when it arrives.
- The component reads data that is always there. It has no `isPending` or
  `data === undefined` branch.

## How to tell

- A component that loads data with no boundary of its own is a bug, even
  though the root error page would catch its error. The session is the
  exception (see above).
- A boundary that wraps more than one data-loading component is too big.
  Wrap each loading component in its own boundary, not a page or a group
  of components. `AuthenticatedLayout`'s `Suspense` is for the session
  only.
- A component that returns `null` or a spinner while `useQuery` loads should
  suspend instead.
- A skeleton that doesn't look like the content it stands for is wrong.
- A boundary may show nothing while it loads only if the component usually
  renders nothing, so a skeleton would shift the layout for most users. It
  still shows its error.
- A component that must never hold up the page, such as the topbar's account
  menu, reads its data without suspending. Say why in a comment.

## How to test

- Hold the response, and check that the skeleton shows. Then release it, and
  check that the content shows.
- Fail the request, and check that the alert shows and the rest of the page
  still works. Then click Try again with a request that succeeds, and check
  that the content shows.
