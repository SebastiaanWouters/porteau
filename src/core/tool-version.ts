const toolVersionPattern = /^(\d+)\.(\d+)\.(\d+)-(\d+)$/u
const semverTriplePattern = /^v?(\d+)\.(\d+)\.(\d+)$/u

function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, '')
  const normalizedRight = right.replace(/^0+(?=\d)/u, '')
  if (normalizedLeft.length !== normalizedRight.length)
    return normalizedLeft.length < normalizedRight.length ? -1 : 1
  if (normalizedLeft === normalizedRight) return 0
  return normalizedLeft < normalizedRight ? -1 : 1
}

export function compareToolVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftParts = toolVersionPattern.exec(left)?.slice(1)
  const rightParts = toolVersionPattern.exec(right)?.slice(1)
  if (!leftParts || !rightParts) return undefined
  for (let index = 0; index < leftParts.length; index += 1) {
    const comparison = compareDecimal(leftParts[index]!, rightParts[index]!)
    if (comparison !== 0) return comparison
  }
  return 0
}

export function semverTripleAtLeast(actual: string, minimum: string): boolean {
  const actualParts = semverTriplePattern.exec(actual)?.slice(1)
  const minimumParts = semverTriplePattern.exec(minimum)?.slice(1)
  if (!actualParts || !minimumParts) return false
  for (let index = 0; index < actualParts.length; index += 1) {
    const comparison = compareDecimal(actualParts[index]!, minimumParts[index]!)
    if (comparison !== 0) return comparison === 1
  }
  return true
}
