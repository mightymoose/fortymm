# Each component that loads data owns its loading and error states

A component that loads data reads it with `useSuspenseQuery`, inside its own
boundary. The boundary shows a skeleton while the data loads, and an inline
error with Try again if the request fails. One boundary wraps one loading
component. The component's file exports the boundary and the component
together, so a caller can't render one without the other.

The root route's error page stays as the safety net. It catches what no
component boundary catches, such as a failed session or a render bug. A
user should see a component's own error first, and the root page only when
nothing nearer could handle the error.

## Why

- A failed request breaks only the part of the page that needed it. The
  rest of the page keeps working, and the user can still leave.
- A page never goes blank. `useQuery` returns `undefined` and no error, so a
  component that returns `null` until its data comes shows nothing forever
  after a failure. `useSuspenseQuery` throws the failure to the boundary.
- A skeleton in the shape of the content tells the user what is coming, and
  the layout doesn't jump when it arrives.
- The component reads data that is always there. It has no `isPending` or
  `data === undefined` branch.

## How to tell

- A component that loads data with no boundary of its own is a bug, even
  though the root error page would catch its error.
- A boundary that wraps more than one data-loading component is too big. Add
  no boundary between the root route and the components.
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
