// Rotate the engine's stable 4×3 coordinates into a fixed portrait view.
// Red is at the top; blue is at the bottom. Data-cell indices remain engine indices.
export const BOARD_ORDER = Object.freeze([3,7,11,2,6,10,1,5,9,0,4,8]);
export function viewSquare(index) {
  return `${Math.floor(index/4)+1}·${4-index%4}`;
}
export function viewDirection([dx,dy]) {
  return [dy,-dx];
}
