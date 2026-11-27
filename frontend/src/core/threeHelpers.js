/**
 * Devuelve true si `obj` debe ignorarse (soporta null, referencia directa o Set).
 */
export function isIgnoredObject(ignoreTarget, obj) {
  if (!ignoreTarget) return false;
  return ignoreTarget instanceof Set ? ignoreTarget.has(obj) : obj === ignoreTarget;
}
