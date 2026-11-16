-- ============================================================
-- schema-v19 — REVIEW INTEGRITY (2026-11-16, launch audit)
--
-- Clients must write their own `deliverables` row (that's how a review is submitted), and RLS
-- can only say "this client may write this row" — not WHAT in it. So a client login could use
-- the anon key directly to forge another reviewer's approval or signature, wipe the
-- expected-reviewers list, or delete deliverables/versions, and the team's review
-- notification would trust it.
--
-- This trigger runs only for CLIENT logins (staff + the service role are untouched) and
-- rejects a deliverables write unless, compared with the stored row:
--   • no deliverable (by id) and no version (by vid) has been removed;
--   • every review / signature that changed is keyed by the writer's OWN email;
--   • expectedReviewers is unchanged, and an existing first signature
--     (v.signature / signedBy / signedDate) is unchanged;
--   • the client isn't creating the row from scratch (staff always create it on first upload).
-- ============================================================

create or replace function public.guard_client_deliverables()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  me text := lower(coalesce(auth.email(), ''));
  od jsonb; nd jsonb; ov jsonb; nv jsonb; k text;
begin
  if new.scope <> 'deliverables' or coalesce(public.my_role(), '') <> 'client' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'clients cannot create the deliverables record' using errcode = '42501';
  end if;
  if me = '' then raise exception 'no signed-in email' using errcode = '42501'; end if;

  for od in select * from jsonb_array_elements(coalesce(old.data, '[]'::jsonb)) loop
    select d.value into nd from jsonb_array_elements(coalesce(new.data, '[]'::jsonb)) as d
      where d.value->>'id' = od->>'id' limit 1;
    if nd is null then
      raise exception 'clients cannot remove a deliverable' using errcode = '42501';
    end if;
    for ov in select * from jsonb_array_elements(coalesce(od->'versions', '[]'::jsonb)) loop
      select v.value into nv from jsonb_array_elements(coalesce(nd->'versions', '[]'::jsonb)) as v
        where v.value->>'vid' = ov->>'vid' limit 1;
      if nv is null then
        raise exception 'clients cannot remove a version' using errcode = '42501';
      end if;
      -- reviews + signatures: anything that changed must be the writer's own entry
      for k in select jsonb_object_keys(coalesce(ov->'reviews', '{}'::jsonb) || coalesce(nv->'reviews', '{}'::jsonb)) loop
        if (ov->'reviews'->k) is distinct from (nv->'reviews'->k) and lower(k) <> me then
          raise exception 'clients can only submit their own review' using errcode = '42501';
        end if;
      end loop;
      for k in select jsonb_object_keys(coalesce(ov->'signatures', '{}'::jsonb) || coalesce(nv->'signatures', '{}'::jsonb)) loop
        if (ov->'signatures'->k) is distinct from (nv->'signatures'->k) and lower(k) <> me then
          raise exception 'clients can only sign for themselves' using errcode = '42501';
        end if;
      end loop;
      if (ov->'expectedReviewers') is distinct from (nv->'expectedReviewers') then
        raise exception 'clients cannot change who reviews' using errcode = '42501';
      end if;
      if coalesce(ov->>'signature', '') <> '' and (
           (ov->'signature') is distinct from (nv->'signature') or
           (ov->'signedBy')  is distinct from (nv->'signedBy') or
           (ov->'signedDate') is distinct from (nv->'signedDate')) then
        raise exception 'clients cannot alter an existing signature' using errcode = '42501';
      end if;
      nv := null;
    end loop;
    nd := null;
  end loop;
  return new;
end; $$;

drop trigger if exists guard_client_deliverables on public.app_state;
create trigger guard_client_deliverables
  before insert or update on public.app_state
  for each row execute function public.guard_client_deliverables();
