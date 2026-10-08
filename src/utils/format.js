/** Presentation helpers used by the side panel and the activity log. */




/** Zero-pad a scene number to at least two digits: 1 -> "01", 12 -> "12". */
export function padSceneNumber(number) {
  return String(number).padStart(2, '0');
}
