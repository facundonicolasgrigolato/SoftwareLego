"""Interfaces base y cadena de resolución (Element ID -> Pieza LDraw + Color)."""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.models import ExtractedPartItem, ResolvedPart


class BasePartResolver(ABC):
    """Contrato común para resolvedores de piezas (SQLite local, overrides, API híbrida)."""

    name: str = "base"

    @abstractmethod
    def resolve(self, item: ExtractedPartItem) -> ResolvedPart | None:
        """Intenta resolver un ítem; devuelve None si delega al siguiente resolvedor."""

    def resolve_with_partial(
        self, item: ExtractedPartItem, partial: ResolvedPart | None = None
    ) -> ResolvedPart | None:
        """Permite enriquecer un `ResolvedPart` previo que quedó `unresolved`."""
        _ = partial
        return self.resolve(item)


class ResolverChain:
    """Ejecuta resolvedores en orden (overrides -> SQLite local -> Camino B online/caché)."""

    def __init__(self, resolvers: list[BasePartResolver]) -> None:
        self.resolvers = resolvers

    def resolve_all(self, items: list[ExtractedPartItem]) -> list[ResolvedPart]:
        resolved: list[ResolvedPart] = []
        for item in items:
            partial: ResolvedPart | None = None
            final_match: ResolvedPart | None = None
            for resolver in self.resolvers:
                candidate = resolver.resolve_with_partial(item, partial)
                if candidate is None:
                    continue
                if candidate.status != "unresolved":
                    final_match = candidate
                    break
                partial = candidate
            if final_match is not None:
                resolved.append(final_match)
            elif partial is not None:
                resolved.append(partial)
            else:
                resolved.append(
                    ResolvedPart(
                        element_id=item.element_id,
                        quantity=item.quantity,
                        status="unresolved",
                        resolution_note="Element ID no encontrado en overrides ni en catálogo local.",
                        source_pages=list(item.source_pages),
                    )
                )
        return resolved
