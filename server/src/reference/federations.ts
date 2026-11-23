/**
 * FIDE federations → countries (ISO 3166-1 alpha-2, `XK` for Kosovo, as the world map and
 * `FlagEmoji` expect). FIDE writes federations as three-letter codes, mostly the IOC's (GER, NED,
 * SUI…), which differ from ISO alpha-3 for many countries, so they are listed here. England,
 * Scotland and Wales play as their own federations and map to GB; `FID` (players under the FIDE
 * flag) has no country.
 *
 * Used to give FIDE players a country from `reference_players.federation` (PGN `WhiteFed` /
 * `BlackFed` tags, broadcast round previews) and from Lichess's FIDE directory, for the world map,
 * opponents' flags and FIDE profiles (`players_cache` kind `fide`, players.ts).
 */
const FEDERATIONS: Readonly<Record<string, string | null>> = {
  AFG: 'AF', AHO: 'CW', ALB: 'AL', ALG: 'DZ', AND: 'AD', ANG: 'AO', ANT: 'AG', ARG: 'AR', ARM: 'AM', ARU: 'AW',
  AUS: 'AU', AUT: 'AT', AZE: 'AZ', BAH: 'BS', BAN: 'BD', BAR: 'BB', BDI: 'BI', BEL: 'BE', BEN: 'BJ', BER: 'BM',
  BHU: 'BT', BIH: 'BA', BIZ: 'BZ', BLR: 'BY', BOL: 'BO', BOT: 'BW', BRA: 'BR', BRN: 'BH', BRU: 'BN', BUL: 'BG',
  BUR: 'BF', CAF: 'CF', CAM: 'KH', CAN: 'CA', CAY: 'KY', CGO: 'CG', CHA: 'TD', CHI: 'CL', CHN: 'CN', CIV: 'CI',
  CMR: 'CM', COD: 'CD', COL: 'CO', COM: 'KM', CPV: 'CV', CRC: 'CR', CRO: 'HR', CUB: 'CU', CUW: 'CW', CYP: 'CY',
  CZE: 'CZ', DEN: 'DK', DJI: 'DJ', DMA: 'DM', DOM: 'DO', ECU: 'EC', EGY: 'EG', ENG: 'GB', ERI: 'ER', ESA: 'SV',
  ESP: 'ES', EST: 'EE', ETH: 'ET', FAI: 'FO', FID: null, FIJ: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GAM: 'GM',
  GBS: 'GW', GCI: 'GG', GEO: 'GE', GEQ: 'GQ', GER: 'DE', GHA: 'GH', GRE: 'GR', GRN: 'GD', GUA: 'GT', GUI: 'GN',
  GUM: 'GU', GUY: 'GY', HAI: 'HT', HKG: 'HK', HON: 'HN', HUN: 'HU', INA: 'ID', IND: 'IN', IOM: 'IM', IRI: 'IR',
  IRL: 'IE', IRQ: 'IQ', ISL: 'IS', ISR: 'IL', ISV: 'VI', ITA: 'IT', IVB: 'VG', JAM: 'JM', JCI: 'JE', JOR: 'JO',
  JPN: 'JP', KAZ: 'KZ', KEN: 'KE', KGZ: 'KG', KOR: 'KR', KOS: 'XK', KSA: 'SA', KUW: 'KW', LAO: 'LA', LAT: 'LV',
  LBA: 'LY', LBN: 'LB', LBR: 'LR', LCA: 'LC', LES: 'LS', LIB: 'LB', LIE: 'LI', LTU: 'LT', LUX: 'LU', MAC: 'MO',
  MAD: 'MG', MAR: 'MA', MAS: 'MY', MAW: 'MW', MDA: 'MD', MDV: 'MV', MEX: 'MX', MGL: 'MN', MKD: 'MK', MLI: 'ML',
  MLT: 'MT', MNC: 'MC', MNE: 'ME', MOZ: 'MZ', MRI: 'MU', MTN: 'MR', MYA: 'MM', NAM: 'NA', NCA: 'NI', NED: 'NL',
  NEP: 'NP', NGR: 'NG', NIG: 'NE', NOR: 'NO', NRU: 'NR', NZL: 'NZ', OMA: 'OM', PAK: 'PK', PAN: 'PA', PAR: 'PY',
  PER: 'PE', PHI: 'PH', PLE: 'PS', PLW: 'PW', PNG: 'PG', POL: 'PL', POR: 'PT', PRK: 'KP', PUR: 'PR', QAT: 'QA',
  ROU: 'RO', RSA: 'ZA', RUS: 'RU', RWA: 'RW', SAM: 'WS', SCO: 'GB', SEN: 'SN', SEY: 'SC', SGP: 'SG', SIN: 'SG',
  SKN: 'KN', SLE: 'SL', SLO: 'SI', SMR: 'SM', SOL: 'SB', SOM: 'SO', SRB: 'RS', SRI: 'LK', SSD: 'SS', STP: 'ST',
  SUD: 'SD', SUI: 'CH', SUR: 'SR', SVK: 'SK', SWE: 'SE', SWZ: 'SZ', SYR: 'SY', TAN: 'TZ', TGA: 'TO', TJK: 'TJ',
  TKM: 'TM', TLS: 'TL', TOG: 'TG', TPE: 'TW', TTO: 'TT', TUN: 'TN', TUR: 'TR', UAE: 'AE', UGA: 'UG', UKR: 'UA',
  URU: 'UY', USA: 'US', UZB: 'UZ', VAN: 'VU', VEN: 'VE', VIE: 'VN', VIN: 'VC', WLS: 'GB', YEM: 'YE', ZAM: 'ZM',
  ZIM: 'ZW',
};

/**
 * The country of a FIDE federation code (`NOR` → `NO`, `GER` → `DE`, `ENG` → `GB`), or null for
 * none, `FID` and unknown codes. Case and surrounding spaces are ignored.
 */
export function federationCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  return FEDERATIONS[code.trim().toUpperCase()] ?? null;
}
