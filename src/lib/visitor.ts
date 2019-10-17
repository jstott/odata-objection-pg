import { Token } from "odata-v4-parser/lib/lexer";
import { Literal } from "odata-v4-literal";
import { SQLLiteral, SQLLang, Visitor } from "odata-v4-sql/lib/visitor";
import { SqlOptions } from "./index";

export class PGVisitor extends Visitor{
	parameters:any[] = [];
	includes:PGVisitor[] = [];

	constructor(options = <SqlOptions>{}){
		super(options);
		(<any>this).parameters = [];
		this.type = SQLLang.PostgreSql;
	}
	/**
	 * returns parameters as {0: 'abc', 1: '2019', ...}
	 */
    public parameterObject() {
		return Object.assign({}, this.parameters )
	}

	from(table:string){
		let sql = `SELECT ${this.select} FROM ${table} WHERE ${this.where} ORDER BY ${this.orderby}`;
		if (typeof this.limit == "number") sql += ` LIMIT ${this.limit}`;
		if (typeof this.skip == "number") sql += ` OFFSET ${this.skip}`;
		return sql;
	}

	protected VisitExpand(node: Token, context: any) {
        node.value.items.forEach((item) => {
            let expandPath = item.value.path.raw;
            let visitor = this.includes.filter(v => v.navigationProperty == expandPath)[0];
            if (!visitor){
                visitor = new PGVisitor(this.options);
				visitor.parameterSeed = this.parameterSeed;
                this.includes.push(visitor);
            }
            visitor.Visit(item);
			this.parameterSeed = visitor.parameterSeed;
        });
    }

	protected VisitSelectItem(node:Token, context:any){
		let item = node.raw.replace(/\//g, '.');
		this.select += `"${item}"`;
	}
    
	protected VisitODataIdentifier(node:Token, context:any){
		let target = node.value.name.replace(/(.)([A-Z][a-z]+)/, '$1_$2').replace(/([a-z0-9])([A-Z])/, '$1_$2').toLowerCase(); // convert to snake_case
        this[context.target] += `"${target}"`;
        context.identifier = node.value.name;
	}

	protected VisitEqualsExpression(node:Token, context:any){
		this.Visit(node.value.left, context);
		this.where += " = ";
		this.Visit(node.value.right, context);
		if (this.options.useParameters && context.literal == null){
			this.where = this.where.replace(/= \:\d$/, "IS NULL").replace(new RegExp(`\\? = "${context.identifier}"$`), `"${context.identifier}" IS NULL`);
		}else if (context.literal == "NULL"){
			this.where = this.where.replace(/= NULL$/, "IS NULL").replace(new RegExp(`NULL = "${context.identifier}"$`), `"${context.identifier}" IS NULL`);
		}
	}

	protected VisitNotEqualsExpression(node:Token, context:any){
		this.Visit(node.value.left, context);
		this.where += " <> ";
		this.Visit(node.value.right, context);
		if (this.options.useParameters && context.literal == null){
			this.where = this.where.replace(/<> \:\d$/, "IS NOT NULL").replace(new RegExp(`\\? <> "${context.identifier}"$`), `"${context.identifier}" IS NOT NULL`);
		}else if (context.literal == "NULL"){
			this.where = this.where.replace(/<> NULL$/, "IS NOT NULL").replace(new RegExp(`NULL <> "${context.identifier}"$`), `"${context.identifier}" IS NOT NULL`);
		}
	}

	protected VisitLiteral(node:Token, context:any){
		if (this.options.useParameters){
			let value = Literal.convert(node.value, node.raw);
			context.literal = value;
			this.parameters.push(value);
			this.where += `:${this.parameters.length-1}`;
		}else this.where += (context.literal = SQLLiteral.convert(node.value, node.raw));
	}

	protected VisitInExpression(node:Token, context:any){
		this.Visit(node.value.left, context);
		this.where += " IN (";
		this.Visit(node.value.right, context);
		this.where += ":list)";
	}

	protected VisitArrayOrObject(node:Token, context:any){
		if (this.options.useParameters){
			let value = node.value.value.items.map(item => item.value === 'number' ? parseInt(item.raw, 10) : item.raw);
			context.literal = value;
			this.parameters.push(value);
			this.where += `:${this.parameters.length-1}`;
		}else this.where += (context.literal = SQLLiteral.convert(node.value, node.raw));
	}

	protected VisitMethodCallExpression(node:Token, context:any){
		var method = node.value.method;
		var params = node.value.parameters || [];
		switch (method){
			case "contains":
				this.Visit(params[0], context);
				if (this.options.useParameters){
					let value = Literal.convert(params[1].value, params[1].raw);
					this.parameters.push(`%${value}%`);
					this.where += ` LIKE :${this.parameters.length-1}`;
				}else this.where += ` LIKE '%${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}%'`;
				break;
			case "endswith":
				this.Visit(params[0], context);
				if (this.options.useParameters){
					let value = Literal.convert(params[1].value, params[1].raw);
					this.parameters.push(`%${value}`);
					this.where += ` LIKE :${this.parameters.length-1}`;
				}else this.where += ` LIKE '%${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}'`;
				break;
			case "startswith":
				this.Visit(params[0], context);
				if (this.options.useParameters){
					let value = Literal.convert(params[1].value, params[1].raw);
					this.parameters.push(`${value}%`);
					this.where += ` LIKE :${this.parameters.length-1}`;
				}else this.where += ` LIKE '${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}%'`;
				break;
			case "substring":
				this.where += "SUBSTR(";
				this.Visit(params[0], context);
				this.where += ", ";
				this.Visit(params[1], context);
				this.where += " + 1";
				if (params[2]){
					this.where += ", ";
					this.Visit(params[2], context);
				}else{
					this.where += ", CHAR_LENGTH(";
					this.Visit(params[0], context);
					this.where += ")";
				}
				this.where += ")";
				break;
			case "substringof":
				this.Visit(params[1], context);
				if (params[0].value == "Edm.String"){
					// HACK - replace __ with . for table.column matching
					this.where = this.where.replace('__','.');
					if (this.options.useParameters){
						let value = Literal.convert(params[0].value, params[0].raw);
						this.parameters.push(`%${value}%`);
						this.where += ` LIKE :${this.parameters.length-1}`;
					}else this.where += ` LIKE '%${SQLLiteral.convert(params[0].value, params[0].raw).slice(1, -1)}%'`;
				}else{
					this.where += " LIKE ";
					this.Visit(params[0], context);
				}
				break;
			case "concat":
				this.where += "(";
				this.Visit(params[0], context);
				this.where += " || ";
				this.Visit(params[1], context);
				this.where += ")";
				break;
			case "round":
				this.where += "ROUND(";
				this.Visit(params[0], context);
				this.where += ")";
				break;
			case "length":
				this.where += "CHAR_LENGTH(";
				this.Visit(params[0], context);
				this.where += ")";
				break;
			case "tolower":
				this.where += "LCASE(";
				this.Visit(params[0], context);
				this.where += ")";
				break;
			case "toupper":
				this.where += "UCASE(";
				this.Visit(params[0], context);
				this.where += ")";
				break;
			case "floor":
			case "ceiling":
			case "year":
			case "month":
			case "day":
			case "hour":
			case "minute":
			case "second":
				this.where += `${method.toUpperCase()}(`;
				this.Visit(params[0], context);
				this.where += ")";
				break;
			case "now":
				this.where += "NOW()";
				break;
			case "trim":
				this.where += "TRIM(BOTH ' ' FROM ";
				this.Visit(params[0], context);
				this.where += ")";
				break;
		}
	}

}