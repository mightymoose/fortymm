"""Stand-ins for a database that fails in a particular way.

Each one listens on 127.0.0.1 and gives a database URL to point the API at. They
fail at the network or at the PostgreSQL wire protocol, which is the contract
between the API and its database, so the API's real driver runs against them.
"""

import asyncio
import contextlib
import socket
import struct
from collections.abc import AsyncIterator, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

_SSL_REQUEST = 80877103
_GSSENC_REQUEST = 80877104
_CANCEL_REQUEST = 80877102


def with_address(database_url: str, host: str, port: int) -> str:
    """The same URL (user, password, database) at another host and port."""
    parts = urlsplit(database_url)
    credentials = parts.netloc.rpartition("@")[0]
    return urlunsplit(parts._replace(netloc=f"{credentials}@{host}:{port}"))


def unused_port() -> int:
    """A local port that nothing listens on, so connecting to it is refused."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
    return port


def unreachable(database_url: str) -> str:
    """The same URL at a local port where connecting is refused."""
    return with_address(database_url, "127.0.0.1", unused_port())


class DatabaseProxy:
    """Forwards TCP to the real database until stopped, so a test can take it away."""

    def __init__(self, database_url: str) -> None:
        upstream = urlsplit(database_url)
        self._upstream = (upstream.hostname or "localhost", upstream.port or 5432)
        self._database_url = database_url
        self._server: asyncio.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()
        self.port = unused_port()

    @property
    def url(self) -> str:
        return with_address(self._database_url, "127.0.0.1", self.port)

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._forward, "127.0.0.1", self.port)

    async def stop(self) -> None:
        """Stop accepting connections and cut the open ones."""
        if self._server is not None:
            self._server.close()
            for writer in list(self._writers):
                writer.close()
            await self._server.wait_closed()
            self._server = None

    async def _forward(
        self, client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter
    ) -> None:
        server_r, server_w = await asyncio.open_connection(*self._upstream)
        self._writers.update((client_w, server_w))
        try:
            await asyncio.gather(_pipe(client_r, server_w), _pipe(server_r, client_w))
        finally:
            for writer in (client_w, server_w):
                self._writers.discard(writer)
                writer.close()


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    with contextlib.suppress(ConnectionError):
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    writer.close()


@contextlib.asynccontextmanager
async def database_proxy(database_url: str) -> AsyncIterator[DatabaseProxy]:
    proxy = DatabaseProxy(database_url)
    await proxy.start()
    try:
        yield proxy
    finally:
        await proxy.stop()


@contextlib.asynccontextmanager
async def _listen(
    database_url: str,
    handle: Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]],
) -> AsyncIterator[str]:
    connections: set[asyncio.StreamWriter] = set()

    async def track(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.add(writer)
        try:
            await handle(reader, writer)
        finally:
            connections.discard(writer)
            writer.close()

    server = await asyncio.start_server(track, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield with_address(database_url, "127.0.0.1", port)
    finally:
        server.close()
        for writer in list(connections):
            writer.close()
        await server.wait_closed()


@contextlib.asynccontextmanager
async def silent_database(database_url: str) -> AsyncIterator[str]:
    """Accepts TCP connections and never sends a byte."""

    async def say_nothing(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while await reader.read(65536):
            pass

    async with _listen(database_url, say_nothing) as url:
        yield url


@contextlib.asynccontextmanager
async def database_that_never_answers_queries(database_url: str) -> AsyncIterator[str]:
    """Completes PostgreSQL's startup handshake, then never answers a query."""

    async def handshake_then_stall(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while True:
            length = struct.unpack("!I", await reader.readexactly(4))[0]
            body = await reader.readexactly(length - 4)
            code = struct.unpack("!I", body[:4])[0]
            if code in (_SSL_REQUEST, _GSSENC_REQUEST):
                writer.write(b"N")  # No encryption; the client sends its startup message next.
                continue
            if code == _CANCEL_REQUEST:
                return
            break  # The startup message.
        writer.write(_message(b"R", struct.pack("!I", 0)))  # AuthenticationOk
        for name, value in (
            ("server_version", "18.0"),
            ("server_encoding", "UTF8"),
            ("client_encoding", "UTF8"),
            ("integer_datetimes", "on"),
        ):
            writer.write(_message(b"S", f"{name}\0{value}\0".encode()))
        writer.write(_message(b"K", struct.pack("!II", 1, 1)))  # BackendKeyData
        writer.write(_message(b"Z", b"I"))  # ReadyForQuery
        await writer.drain()
        while await reader.read(65536):
            pass  # Every query goes unanswered.

    async with _listen(database_url, handshake_then_stall) as url:
        yield url


def _message(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack("!I", len(payload) + 4) + payload
