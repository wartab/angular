/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {FunctionExtractor} from '@angular/compiler-cli/src/ngtsc/docs/src/function_extractor';
import ts from 'typescript';

import {Reference} from '../../imports';
import {DirectiveMeta, InputMapping, InputOrOutput, MetadataReader} from '../../metadata';
import {ClassDeclaration} from '../../reflection';

import {ClassEntry, DirectiveEntry, EntryType, MemberEntry, MemberTags, MemberType, MethodEntry, PropertyEntry} from './entities';
import {extractResolvedTypeString} from './type_extractor';

/** A class member declaration that is *like* a property (including accessors) */
type PropertyDeclarationLike = ts.PropertyDeclaration|ts.AccessorDeclaration;

/** Extractor to pull info for API reference documentation for a TypeScript class. */
class ClassExtractor {
  constructor(
      protected declaration: ClassDeclaration,
      protected reference: Reference,
      protected typeChecker: ts.TypeChecker,
  ) {}

  /** Extract docs info specific to classes. */
  extract(): ClassEntry {
    return {
      name: this.declaration.name!.text,
      entryType: EntryType.undecorated_class,
      members: this.extractAllClassMembers(this.declaration as ts.ClassDeclaration),
    };
  }

  /** Extracts doc info for a class's members. */
  protected extractAllClassMembers(classDeclaration: ts.ClassDeclaration): MemberEntry[] {
    const members: MemberEntry[] = [];

    for (const member of classDeclaration.members) {
      if (this.isMemberExcluded(member)) continue;

      const memberEntry = this.extractClassMember(member);
      if (memberEntry) {
        members.push(memberEntry);
      }
    }

    return members;
  }

  /** Extract docs for a class's members (methods and properties).  */
  protected extractClassMember(memberDeclaration: ts.ClassElement): MemberEntry|undefined {
    if (ts.isMethodDeclaration(memberDeclaration)) {
      return this.extractMethod(memberDeclaration);
    } else if (ts.isPropertyDeclaration(memberDeclaration)) {
      return this.extractClassProperty(memberDeclaration);
    } else if (ts.isAccessor(memberDeclaration)) {
      return this.extractGetterSetter(memberDeclaration);
    }

    // We only expect methods, properties, and accessors. If we encounter something else,
    // return undefined and let the rest of the program filter it out.
    return undefined;
  }

  /** Extracts docs for a class method. */
  protected extractMethod(methodDeclaration: ts.MethodDeclaration): MethodEntry {
    const functionExtractor = new FunctionExtractor(methodDeclaration, this.typeChecker);
    return {
      ...functionExtractor.extract(),
      memberType: MemberType.method,
      memberTags: this.getMemberTags(methodDeclaration),
    };
  }

  /** Extracts doc info for a property declaration. */
  protected extractClassProperty(propertyDeclaration: PropertyDeclarationLike): PropertyEntry {
    return {
      name: propertyDeclaration.name.getText(),
      type: extractResolvedTypeString(propertyDeclaration, this.typeChecker),
      memberType: MemberType.property,
      memberTags: this.getMemberTags(propertyDeclaration),
    };
  }

  /** Extracts doc info for an accessor member (getter/setter). */
  protected extractGetterSetter(accessor: ts.AccessorDeclaration): PropertyEntry {
    return {
      ...this.extractClassProperty(accessor),
      memberType: ts.isGetAccessor(accessor) ? MemberType.getter : MemberType.setter,
    };
  }

  /** Gets the tags for a member (protected, readonly, static, etc.) */
  protected getMemberTags(member: ts.MethodDeclaration|ts.PropertyDeclaration|
                          ts.AccessorDeclaration): MemberTags[] {
    const tags: MemberTags[] = this.getMemberTagsFromModifiers(member.modifiers ?? []);

    if (member.questionToken) {
      tags.push(MemberTags.optional);
    }

    return tags;
  }

  /** Get the tags for a member that come from the declaration modifiers. */
  private getMemberTagsFromModifiers(mods: Iterable<ts.ModifierLike>): MemberTags[] {
    const tags: MemberTags[] = [];
    for (const mod of mods) {
      const tag = this.getTagForMemberModifier(mod);
      if (tag) tags.push(tag);
    }
    return tags;
  }

  /** Gets the doc tag corresponding to a class member modifier (readonly, protected, etc.). */
  private getTagForMemberModifier(mod: ts.ModifierLike): MemberTags|undefined {
    switch (mod.kind) {
      case ts.SyntaxKind.StaticKeyword:
        return MemberTags.static;
      case ts.SyntaxKind.ReadonlyKeyword:
        return MemberTags.readonly;
      case ts.SyntaxKind.ProtectedKeyword:
        return MemberTags.protected;
      default:
        return undefined;
    }
  }

  /**
   * Gets whether a given class member should be excluded from public API docs.
   * This is the case if:
   *  - The member does not have a name
   *  - The member is neither a method nor property
   *  - The member is protected
   */
  private isMemberExcluded(member: ts.ClassElement): boolean {
    return !member.name || !this.isDocumentableMember(member) ||
        !!member.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword);
  }

  /** Gets whether a class member is a method, property, or accessor. */
  private isDocumentableMember(member: ts.ClassElement): member is ts.MethodDeclaration
      |ts.PropertyDeclaration {
    return ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) ||
        ts.isAccessor(member);
  }
}

/** Extractor to pull info for API reference documentation for an Angular directive. */
class DirectiveExtractor extends ClassExtractor {
  constructor(
      declaration: ClassDeclaration,
      reference: Reference,
      protected metadata: DirectiveMeta,
      checker: ts.TypeChecker,
  ) {
    super(declaration, reference, checker);
  }

  /** Extract docs info for directives and components (including underlying class info). */
  override extract(): DirectiveEntry {
    return {
      ...super.extract(),
      isStandalone: this.metadata.isStandalone,
      selector: this.metadata.selector ?? '',
      exportAs: this.metadata.exportAs ?? [],
      entryType: this.metadata.isComponent ? EntryType.component : EntryType.directive,
    };
  }

  /** Extracts docs info for a directive property, including input/output metadata. */
  override extractClassProperty(propertyDeclaration: ts.PropertyDeclaration): PropertyEntry {
    const entry = super.extractClassProperty(propertyDeclaration);

    const inputMetadata = this.getInputMetadata(propertyDeclaration);
    if (inputMetadata) {
      entry.memberTags.push(MemberTags.input);
      entry.inputAlias = inputMetadata.bindingPropertyName;
    }

    const outputMetadata = this.getOutputMetadata(propertyDeclaration);
    if (outputMetadata) {
      entry.memberTags.push(MemberTags.output);
      entry.outputAlias = outputMetadata.bindingPropertyName;
    }

    return entry;
  }

  /** Gets the input metadata for a directive property. */
  private getInputMetadata(prop: ts.PropertyDeclaration): InputMapping|undefined {
    const propName = prop.name.getText();
    return this.metadata.inputs?.getByClassPropertyName(propName) ?? undefined;
  }

  /** Gets the output metadata for a directive property. */
  private getOutputMetadata(prop: ts.PropertyDeclaration): InputOrOutput|undefined {
    const propName = prop.name.getText();
    return this.metadata?.outputs?.getByClassPropertyName(propName) ?? undefined;
  }
}

/** Extracts documentation info for a class, potentially including Angular-specific info.  */
export function extractClass(
    classDeclaration: ClassDeclaration, metadataReader: MetadataReader,
    typeChecker: ts.TypeChecker): ClassEntry {
  const ref = new Reference(classDeclaration);
  const metadata = metadataReader.getDirectiveMetadata(ref);
  const extractor = metadata ?
      new DirectiveExtractor(classDeclaration, ref, metadata, typeChecker) :
      new ClassExtractor(classDeclaration, ref, typeChecker);

  return extractor.extract();
}