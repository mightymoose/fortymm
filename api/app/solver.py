from ortools.sat.python import cp_model


def solve_hello_world() -> bool:
    model = cp_model.CpModel()
    x = model.NewIntVar(0, 10, "x")
    y = model.NewIntVar(0, 10, "y")
    model.Add(x + y == 10)
    solver = cp_model.CpSolver()
    status = solver.Solve(model)
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
