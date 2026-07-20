export function validPosition(position, label = "position") {
  if (
    !position ||
    !Number.isInteger(position.currentPage) ||
    position.currentPage < 1 ||
    !Number.isFinite(position.scrollTop) ||
    position.scrollTop < 0
  ) {
    throw new TypeError(`${label} must contain a valid currentPage and scrollTop`);
  }
  return {
    currentPage: position.currentPage,
    scrollTop: position.scrollTop,
  };
}

export function samePosition(left, right) {
  return (
    left.currentPage === right.currentPage && left.scrollTop === right.scrollTop
  );
}
