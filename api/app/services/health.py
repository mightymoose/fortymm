import fortymm_core


class HealthService:
    """Checks the api's dependencies. The endpoint builds the response from what it reports."""

    @property
    def core_healthy(self) -> bool:
        """The Rust core is loaded and answers as it should."""
        return fortymm_core.hello_world() == "Hello World"
