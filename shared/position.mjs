// @ts-check

/** @typedef {import("../types/storage.d.ts").Position} Position */
/** @typedef {{ currentPage?: unknown, scrollTop?: unknown }} PositionCandidate */

/**
 * @param {unknown} position
 * @param {string} [label]
 * @returns {Position}
 */
export function validPosition(position, label = "position") {
  if (
    !position ||
    !Number.isInteger(
      /** @type {PositionCandidate} */ (position).currentPage,
    ) ||
    /** @type {number} */ (
      /** @type {PositionCandidate} */ (position).currentPage
    ) < 1 ||
    !Number.isFinite(
      /** @type {PositionCandidate} */ (position).scrollTop,
    ) ||
    /** @type {number} */ (
      /** @type {PositionCandidate} */ (position).scrollTop
    ) < 0
  ) {
    throw new TypeError(`${label} must contain a valid currentPage and scrollTop`);
  }
  return {
    currentPage: /** @type {number} */ (
      /** @type {PositionCandidate} */ (position).currentPage
    ),
    scrollTop: /** @type {number} */ (
      /** @type {PositionCandidate} */ (position).scrollTop
    ),
  };
}

/**
 * @param {Position} left
 * @param {Position} right
 */
export function samePosition(left, right) {
  return (
    left.currentPage === right.currentPage && left.scrollTop === right.scrollTop
  );
}
