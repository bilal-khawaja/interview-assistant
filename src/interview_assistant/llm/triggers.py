MIN_NEW_TOKENS = 20
STALE_THRESHOLD_MS = 2500


def live_rail_trigger(
    new_tokens: int,
    turn_ended: bool,
    elapsed_ms: int,
) -> bool:

    if turn_ended:
        return True

    if new_tokens >= MIN_NEW_TOKENS:
        return True

    if elapsed_ms >= STALE_THRESHOLD_MS:
        return True

    return False
