-- Administrators requested persistent, directly copyable invite codes.
-- This private column is exposed only through admin-guarded RPCs.

alter table private.activation_codes
  add column if not exists code_value text;

create unique index if not exists activation_codes_code_value_unique
  on private.activation_codes(code_value)
  where code_value is not null;

create or replace function public.admin_generate_activation_codes_v3(
  p_label text,
  p_duration_days integer,
  p_count integer default 1,
  p_valid_until timestamptz default null,
  p_channel text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  v_result := public.admin_generate_activation_codes_v2(
    p_label, p_duration_days, p_count, p_valid_until, p_channel
  );
  update private.activation_codes code
  set code_value = generated.item->>'code'
  from jsonb_array_elements(v_result->'codes') generated(item)
  where code.id = (generated.item->>'id')::uuid;
  return v_result;
end;
$$;

create or replace function public.admin_list_activation_codes_v2(
  p_query text default '',
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 25,
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_items jsonb;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  v_result := public.admin_list_activation_codes_v1(
    p_query, p_status, p_page, p_page_size, p_batch_id
  );
  select coalesce(jsonb_agg(item.value || jsonb_build_object('code', code.code_value)
    order by item.ordinality), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(v_result->'items') with ordinality item(value, ordinality)
  left join private.activation_codes code
    on code.id = (item.value->>'id')::uuid;
  return jsonb_set(v_result, '{items}', v_items, true);
end;
$$;

create or replace function public.admin_reissue_activation_code_v2(
  p_code_id uuid,
  p_valid_until timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  v_result := public.admin_reissue_activation_code_v1(p_code_id, p_valid_until);
  update private.activation_codes
  set code_value = v_result->'code'->>'code'
  where id = (v_result->'code'->>'id')::uuid;
  return v_result;
end;
$$;

revoke all on function public.admin_generate_activation_codes_v3(text,integer,integer,timestamptz,text)
  from public, anon;
revoke all on function public.admin_list_activation_codes_v2(text,text,integer,integer,uuid)
  from public, anon;
revoke all on function public.admin_reissue_activation_code_v2(uuid,timestamptz)
  from public, anon;
grant execute on function public.admin_generate_activation_codes_v3(text,integer,integer,timestamptz,text)
  to authenticated;
grant execute on function public.admin_list_activation_codes_v2(text,text,integer,integer,uuid)
  to authenticated;
grant execute on function public.admin_reissue_activation_code_v2(uuid,timestamptz)
  to authenticated;
