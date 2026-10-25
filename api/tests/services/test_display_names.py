import re
from collections import Counter

from fortymm_api.services.display_names import ADJECTIVES, ANIMALS


def test_every_animal_has_an_adjective_with_its_initial() -> None:
    initials = {adjective[0] for adjective in ADJECTIVES}

    assert [animal for animal in ANIMALS if animal[0] not in initials] == []


def test_every_word_is_one_lowercase_word_listed_once() -> None:
    words = ANIMALS + ADJECTIVES

    assert [word for word in words if not re.fullmatch("[a-z]+", word)] == []
    assert [word for word, n in Counter(words).items() if n > 1] == []


def test_has_room_for_a_million_names() -> None:
    initials = Counter(adjective[0] for adjective in ADJECTIVES)
    pairs = sum(initials[animal[0]] for animal in ANIMALS)

    assert pairs * 900 >= 1_000_000
