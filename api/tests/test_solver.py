from app.solver import solve_hello_world


def test_solve_hello_world_returns_true():
    assert solve_hello_world() is True
