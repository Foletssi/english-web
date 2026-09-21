create or replace function public.admin_get_processing_video_content_v1(p_video_id text)
returns table(video jsonb,sentences jsonb,revision bigint,updated_at timestamptz)
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select v.value,coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb),c.revision,c.updated_at
  from private.content_snapshots c
  cross join lateral jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) v(value)
  where c.environment='production' and v.value->>'id'=p_video_id
  limit 1;
end;
$$;

revoke all on function public.admin_get_processing_video_content_v1(text) from public,anon;
grant execute on function public.admin_get_processing_video_content_v1(text) to authenticated;
