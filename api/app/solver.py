from ortools.sat.python import cp_model


def solve_hello_world() -> bool:
    model = cp_model.CpModel()
    x = model.new_int_var(0, 10, "x")
    y = model.new_int_var(0, 10, "y")
    model.add(x + y == 10)
    solver = cp_model.CpSolver()
    status = solver.solve(model)
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
