def solve(points):
    """Return a tour: a permutation of city indices, visited in that order.

    Deliberately weak baseline: visit the cities in the order they were given.
    It produces a valid tour, it is just a very long one.
    """
    return list(range(len(points)))
