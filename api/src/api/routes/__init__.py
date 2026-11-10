"""The HTTP layer. Each route gets its service from api.dependencies, calls it, and turns
the result into a status code and a body. No logic of its own."""
