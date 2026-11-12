import { familyKey, type CustomFont, type FontScope } from '../shared/fonts.ts'
import { WEB_FONTS_ORIGIN } from '../shared/webFonts.ts'
import { FontInputError, addFont, listFonts } from './fonts.ts'

/**
 * Google Fonts into a font library. Asked for a stylesheet without a browser
 * User-Agent, css2 answers with one complete TTF per requested face, where a
 * browser would get unicode-range subsets of WOFF2 that are no use as a
 * single library file. Each file then goes through addFont, exactly as an
 * upload does, so validation, the size limit, storage and replace-on-re-add
 * are not repeated here.
 */

/** The only host a font file may come from: the stylesheet is untrusted input
 *  to a server-side fetch, so it must not be able to aim it elsewhere. */
const FILE_HOST = 'fonts.gstatic.com'
const FETCH_TIMEOUT_MS = 20_000

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    throw new FontInputError('Google Fonts could not be reached — try again')
  }
}

function stylesheetUrl(family: string, weights: readonly number[], italic: boolean): string {
  const sorted = [...new Set(weights)].sort((a, b) => a - b)
  /* Google wants the axis tuples sorted, normal before italic */
  const axes = italic
    ? `ital,wght@${[0, 1].flatMap((ital) => sorted.map((w) => `${ital},${w}`)).join(';')}`
    : `wght@${sorted.join(';')}`
  return `${WEB_FONTS_ORIGIN}/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}`
}

function fontFileUrls(css: string): URL[] {
  const urls = [...css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)].map((m) => m[1] ?? '')
  return [...new Set(urls)].map((raw) => {
    const url = URL.canParse(raw) ? new URL(raw) : null
    if (url?.protocol !== 'https:' || url.host !== FILE_HOST)
      throw new FontInputError(`refusing the font file at ${url?.host ?? raw}: only https://${FILE_HOST} is allowed`)
    return url
  })
}

/** Add a Google Fonts family, at the given weights, to a library; returns the
 *  library's rows for that family afterwards. */
export async function addGoogleFont(
  scope: FontScope,
  user: { id: string; name: string },
  family: string,
  weights: readonly number[],
  italic: boolean,
): Promise<CustomFont[]> {
  const name = family.trim().replace(/\s+/g, ' ')
  if (!/^[A-Za-z0-9 ]{1,80}$/.test(name)) throw new FontInputError(`"${family}" is not a Google Fonts family name`)
  const res = await get(stylesheetUrl(name, weights, italic))
  if (res.status === 400)
    throw new FontInputError(
      `Google Fonts has no family "${name}" with weights ${weights.join(', ')}${italic ? ' and italics' : ''}`,
    )
  if (!res.ok) throw new FontInputError(`Google Fonts answered HTTP ${res.status}`)
  const urls = fontFileUrls(await res.text())
  if (!urls.length) throw new FontInputError(`Google Fonts returned no font files for "${name}"`)
  /* every file is fetched before the first is stored, so a failure leaves the library as it was */
  const files: { buf: Buffer; fileName: string }[] = []
  for (const url of urls) {
    const file = await get(url.href)
    if (!file.ok) throw new FontInputError(`Google Fonts answered HTTP ${file.status} for a font file`)
    files.push({ buf: Buffer.from(await file.arrayBuffer()), fileName: url.pathname.split('/').pop() ?? '' })
  }
  const added = new Set<string>()
  for (const { buf, fileName } of files) added.add(familyKey((await addFont(scope, user, buf, fileName)).family))
  return listFonts(scope, user.id).filter((font) => added.has(familyKey(font.family)))
}
