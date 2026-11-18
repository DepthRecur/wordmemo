import { describe, expect, it } from 'vitest'
import { combineIpa, inflectIpa, lemmaCandidates, splitPhrase } from '../src/main/media/phonetic'

describe('词组音标', () => {
  it('按空格拆词，保留词内连字符和撇号', () => {
    expect(splitPhrase('be contradictory to')).toEqual(['be', 'contradictory', 'to'])
    expect(splitPhrase('A be contradictory to B')).toEqual(['A', 'be', 'contradictory', 'to', 'B'])
    expect(splitPhrase("don't well-known")).toEqual(["don't", 'well-known'])
  })

  it('逐词音标按原顺序拼接，缺失词用 … 占位', () => {
    expect(combineIpa(['/biː/', '/ˌkɒntrəˈdɪktəri/', '/tuː/'])).toBe(
      '/biː ˌkɒntrəˈdɪktəri tuː/'
    )
    expect(combineIpa(['/biː/', null, '/tuː/'])).toBe('/biː … tuː/')
  })

  it('屈折形式能还原到原形并推导音标', () => {
    expect(lemmaCandidates('contradicts')).toContain('contradict')
    expect(lemmaCandidates('studies')).toContain('study')
    expect(lemmaCandidates('watches')).toContain('watch')
    expect(inflectIpa('/kɒntrəˈdɪkt/', 'contradicts')).toBe('/kɒntrəˈdɪkts/')
    expect(inflectIpa('/wɒtʃ/', 'watches')).toBe('/wɒtʃɪz/')
    expect(inflectIpa('/lʌv/', 'loved')).toBe('/lʌvd/')
  })
})
