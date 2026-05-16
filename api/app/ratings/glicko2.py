"""Vendored Glicko-2 implementation. Reference: Glickman 2013.

Each match is its own one-game rating period for both players — the simplest
mapping that produces an update on every result.
"""
import math
from typing import Any

TAU = 0.5  # system constant, dampens volatility changes
SCALE = 173.7178  # Glicko-2 conversion factor
EPSILON = 1e-6


def _g(phi: float) -> float:
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))


def _e(mu: float, mu_j: float, phi_j: float) -> float:
    return 1.0 / (1.0 + math.exp(-_g(phi_j) * (mu - mu_j)))


def _new_volatility(phi: float, v: float, delta: float, sigma: float) -> float:
    """Illinois algorithm for the new volatility (Glickman 2013, step 5)."""
    a = math.log(sigma * sigma)

    def f(x: float) -> float:
        ex = math.exp(x)
        num = ex * (delta * delta - phi * phi - v - ex)
        den = 2.0 * (phi * phi + v + ex) ** 2
        return num / den - (x - a) / (TAU * TAU)

    A = a
    if delta * delta > phi * phi + v:
        B = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * TAU) < 0:
            k += 1
        B = a - k * TAU

    fA = f(A)
    fB = f(B)
    while abs(B - A) > EPSILON:
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB <= 0:
            A, fA = B, fB
        else:
            fA = fA / 2.0
        B, fB = C, fC
    return math.exp(A / 2.0)


def _update_one(
    player: dict[str, Any], opp: dict[str, Any], score: float
) -> dict[str, Any]:
    mu = (player["rating"] - 1500.0) / SCALE
    phi = player["rd"] / SCALE
    sigma = player["volatility"]

    mu_j = (opp["rating"] - 1500.0) / SCALE
    phi_j = opp["rd"] / SCALE
    g_j = _g(phi_j)
    e_j = _e(mu, mu_j, phi_j)

    v = 1.0 / (g_j * g_j * e_j * (1.0 - e_j))
    sum_term = g_j * (score - e_j)
    delta = v * sum_term

    new_sigma = _new_volatility(phi, v, delta, sigma)
    phi_star = math.sqrt(phi * phi + new_sigma * new_sigma)
    new_phi = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    new_mu = mu + new_phi * new_phi * sum_term

    return {
        "rating": SCALE * new_mu + 1500.0,
        "rd": SCALE * new_phi,
        "volatility": new_sigma,
    }


class Glicko2Calculator:
    key = "glicko2"

    def update_singles(
        self,
        winner_state: dict[str, Any],
        loser_state: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        new_winner = _update_one(winner_state, loser_state, 1.0)
        new_loser = _update_one(loser_state, winner_state, 0.0)
        return new_winner, new_loser


CALCULATOR = Glicko2Calculator()
