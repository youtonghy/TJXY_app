import { clientRequest, type ClientSession } from './http.ts';

export interface MediaNamedCode {
  Code: string;
  Name: string;
}

export interface MediaPerson {
  Id: string;
  Name: string;
  Role?: string;
  Type?: string;
}

export interface MediaUserData {
  IsFavorite?: boolean;
  Played?: boolean;
  PlaybackPositionTicks?: number;
}

export interface MediaItem {
  Id: string;
  Name: string;
  Type?: string;
  IsFolder?: boolean;
  ParentId?: string;
  ProductionYear?: number;
  Overview?: string;
  OriginalTitle?: string;
  CommunityRating?: number;
  IndexNumber?: number;
  Tagline?: string;
  VoteCount?: number;
  RunTimeTicks?: number;
  PremiereDate?: string;
  EndDate?: string;
  OfficialRating?: string;
  Status?: string;
  OriginalLanguage?: string;
  Genres?: string[];
  Studios?: string[];
  Countries?: MediaNamedCode[];
  Languages?: MediaNamedCode[];
  People?: MediaPerson[];
  HasMediaSources?: boolean;
  PrimaryImageTag?: string;
  ImageTags?: Record<string, string>;
  UserData?: MediaUserData;
}

export interface LibraryFilterFacets {
  Genres: string[];
  ProductionYears: number[];
}

export interface ItemPage {
  Items: MediaItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface Library {
  Id: string;
  Name: string;
  CollectionType?: string;
  ImageTags?: Record<string, string>;
}

export interface GetItemsOptions {
  genre?: string;
  includeItemTypes?: string;
  limit?: number;
  parentId?: string;
  productionYear?: number;
  recursive?: boolean;
  sortBy?: 'DateCreated' | 'ProductionYear' | 'Runtime' | 'SortName';
  sortOrder?: 'Ascending' | 'Descending';
  startIndex?: number;
}

export async function authenticate(session: ClientSession, username: string, password: string): Promise<string> {
  const auth = await clientRequest<{ AccessToken?: string }>(session, '/Users/AuthenticateByName', {
    method: 'POST',
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!auth.AccessToken) throw new Error('invalid-response');
  return auth.AccessToken;
}

export async function getMe(session: ClientSession): Promise<{ Id: string; Name: string }> {
  return clientRequest(session, '/Users/Me');
}

export async function logout(session: ClientSession): Promise<void> {
  await clientRequest(session, '/Sessions/Logout', { method: 'POST' });
}

export async function getLibraries(session: ClientSession): Promise<Library[]> {
  const value = await clientRequest<{ Items?: Library[] }>(session, '/UserViews');
  return Array.isArray(value.Items) ? value.Items : [];
}

export async function getItems(session: ClientSession, params: GetItemsOptions = {}): Promise<ItemPage> {
  const query = new URLSearchParams({
    limit: String(params.limit ?? 24),
    startIndex: String(params.startIndex ?? 0),
  });
  if (params.parentId) query.set('parentId', params.parentId);
  if (params.includeItemTypes) query.set('includeItemTypes', params.includeItemTypes);
  if (params.genre) query.set('genre', params.genre);
  if (params.productionYear) query.set('productionYear', String(params.productionYear));
  if (params.recursive !== undefined) query.set('recursive', String(params.recursive));
  if (params.sortBy) query.set('sortBy', params.sortBy);
  if (params.sortOrder) query.set('sortOrder', params.sortOrder);
  return clientRequest<ItemPage>(session, `/Items?${query}`);
}

export async function getLatest(
  session: ClientSession,
  options: { limit?: number; parentId?: string; includeItemTypes?: string } = {},
): Promise<MediaItem[]> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 18) });
  if (options.parentId) query.set('parentId', options.parentId);
  if (options.includeItemTypes) query.set('includeItemTypes', options.includeItemTypes);
  const value = await clientRequest<unknown>(session, `/Items/Latest?${query}`);
  return Array.isArray(value) ? value as MediaItem[] : [];
}

export async function getPopular(session: ClientSession, limit = 12): Promise<MediaItem[]> {
  try {
    const value = await clientRequest<ItemPage>(session, `/Discover/Popular?limit=${limit}`);
    if (Array.isArray(value.Items) && value.Items.length > 0) return value.Items;
  } catch {
    /* fall through */
  }
  return getLatest(session, { limit, includeItemTypes: 'Movie,Series' });
}

export async function getSimilarItems(session: ClientSession, id: string, limit = 8): Promise<MediaItem[]> {
  const value = await clientRequest<ItemPage>(session, `/Items/${encodeURIComponent(id)}/Similar?limit=${String(limit)}`);
  return Array.isArray(value.Items) ? value.Items : [];
}

export async function getLibraryFilterFacets(session: ClientSession, parentId: string): Promise<LibraryFilterFacets> {
  const value = await clientRequest<Partial<LibraryFilterFacets>>(
    session,
    `/Items/Filters?parentId=${encodeURIComponent(parentId)}`,
  );
  return {
    Genres: Array.isArray(value.Genres) ? value.Genres : [],
    ProductionYears: Array.isArray(value.ProductionYears) ? value.ProductionYears : [],
  };
}

export async function getResumeItems(session: ClientSession, limit = 12): Promise<MediaItem[]> {
  const value = await clientRequest<ItemPage>(
    session,
    `/UserItems/Resume?mediaTypes=Video&limit=${limit}&enableUserData=true`,
  );
  return Array.isArray(value.Items) ? value.Items : [];
}

export async function getItem(session: ClientSession, id: string): Promise<MediaItem> {
  return clientRequest<MediaItem>(session, `/Items/${encodeURIComponent(id)}`);
}

export async function getChildren(session: ClientSession, parentId: string): Promise<MediaItem[]> {
  return (await getItems(session, { parentId, limit: 200 })).Items;
}

export async function searchHints(session: ClientSession, term: string): Promise<MediaItem[]> {
  const value = await clientRequest<{ SearchHints?: MediaItem[] }>(
    session,
    `/Search/Hints?searchTerm=${encodeURIComponent(term)}&limit=24`,
  );
  return Array.isArray(value.SearchHints) ? value.SearchHints : [];
}

export async function toggleFavorite(session: ClientSession, userId: string, itemId: string, favorite: boolean): Promise<void> {
  await clientRequest(session, `/Users/${userId}/FavoriteItems/${itemId}`, { method: favorite ? 'POST' : 'DELETE' });
}

export async function togglePlayed(session: ClientSession, userId: string, itemId: string, played: boolean): Promise<void> {
  await clientRequest(session, `/Users/${userId}/PlayedItems/${itemId}`, { method: played ? 'POST' : 'DELETE' });
}

export function latestTypesForLibrary(library: Library): string | undefined {
  if (library.CollectionType === 'movies') return 'Movie';
  if (library.CollectionType === 'tvshows') return 'Series';
  if (library.CollectionType === 'music') return 'Audio';
  return undefined;
}

export function imagePath(item: MediaItem): string | undefined {
  const tag = item.PrimaryImageTag ?? item.ImageTags?.Primary;
  if (!tag) return undefined;
  return `/Items/${item.Id}/Images/Primary?tag=${encodeURIComponent(tag)}`;
}

export interface PublicSiteBranding {
  SiteTitle: string;
  SiteSubtitle: string;
  LogoUrl: string;
  Theme: PublicSiteTheme;
}

export interface PublicSiteTheme {
  id: string;
  schemaVersion: number;
  options: Record<string, unknown>;
  revision: number;
}

export async function getPublicBranding(
  session: ClientSession,
  signal?: AbortSignal,
): Promise<PublicSiteBranding> {
  const value = await clientRequest<Partial<PublicSiteBranding> & { Theme?: unknown }>(
    session,
    '/System/Settings',
    signal ? { signal } : {},
  );
  return {
    SiteTitle: value.SiteTitle?.trim() || 'TJXY',
    SiteSubtitle: value.SiteSubtitle?.trim() || 'Your media library',
    LogoUrl: value.LogoUrl?.trim() || '/brand/tjxy-mark.webp',
    Theme: parsePublicTheme(value.Theme),
  };
}

function parsePublicTheme(value: unknown): PublicSiteTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultPublicTheme();
  const theme = value as Record<string, unknown>;
  return {
    id: typeof theme.Id === 'string' && theme.Id.trim() ? theme.Id : 'classic',
    schemaVersion: Number.isSafeInteger(theme.SchemaVersion) && Number(theme.SchemaVersion) > 0
      ? Number(theme.SchemaVersion)
      : 1,
    options: theme.Options && typeof theme.Options === 'object' && !Array.isArray(theme.Options)
      ? theme.Options as Record<string, unknown>
      : {},
    revision: Number.isSafeInteger(theme.Revision) && Number(theme.Revision) >= 0
      ? Number(theme.Revision)
      : 0,
  };
}

function defaultPublicTheme(): PublicSiteTheme {
  return { id: 'classic', schemaVersion: 1, options: {}, revision: 0 };
}
