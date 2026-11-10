import asyncpg


async def ping(database_url: str) -> None:
    """Run SELECT 1 on a new connection. Raises if the database does not answer.

    Has no timeout of its own: the caller bounds it.
    """
    connection = await asyncpg.connect(database_url)
    try:
        await connection.fetchval("SELECT 1")
    except BaseException:
        # Cancelled or failed mid-query: drop the socket without waiting on the server.
        connection.terminate()
        raise
    await connection.close()
